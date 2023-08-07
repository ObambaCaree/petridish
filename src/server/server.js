/*jslint bitwise: true, node: true */
'use strict';

const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const quadtree = require('simple-quadtree');
const SAT = require('sat');

const gameLogic = require('./game-logic');
const playerLogic = require('./player');
const loggingRepositry = require('./repositories/logging-repository');
const chatRepository = require('./repositories/chat-repository');
const config = require('../../config');
const util = require('./lib/util');
const mapUtils = require('./map/map');

const tree = quadtree(0, 0, config.gameWidth, config.gameHeight);

let map = new mapUtils.Map(config);

let users = [];
let spectators = [];
let sockets = {};

let leaderboard = [];
let leaderboardChanged = false;

const Vector = SAT.Vector;
const Circle = SAT.Circle;

let playerCircle = new Circle(new Vector(0, 0), 0);

app.use(express.static(__dirname + '/../client'));

io.on('connection', function (socket) {
    let type = socket.handshake.query.type;
    console.log('User has connected: ', type);
    switch (type) {
        case 'player':
            addPlayer(socket);
            break;
        case 'spectator':
            addSpectator(socket);
            break;
        default:
            console.log('Unknown user type, not doing anything.');
    }
});

const addPlayer = (socket) => {
    let radius = util.massToRadius(config.defaultPlayerMass);
    let position = config.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(users, radius) : util.randomPosition(radius);

    let cells= [{
        mass: config.defaultPlayerMass,
        x: position.x,
        y: position.y,
        radius: radius
    }];
    let massTotal = config.defaultPlayerMass;

    var currentPlayer = {
        id: socket.id,
        ipAddress: socket.handshake.address,
        x: position.x,
        y: position.y,
        w: config.defaultPlayerMass,
        h: config.defaultPlayerMass,
        cells: cells,
        massTotal: massTotal,
        hue: Math.round(Math.random() * 360),
        type: 'player',
        lastHeartbeat: new Date().getTime(),
        target: {
            x: 0,
            y: 0
        }
    };

    socket.on('gotit', function (player) {
        console.log('[INFO] Player ' + player.name + ' connecting!');

        if (util.findIndex(users, player.id) > -1) {
            console.log('[INFO] Player ID is already connected, kicking.');
            socket.disconnect();
        } else if (!util.validNick(player.name)) {
            socket.emit('kick', 'Invalid username.');
            socket.disconnect();
        } else {
            console.log('[INFO] Player ' + player.name + ' connected!');
            sockets[player.id] = socket;

            var radius = util.massToRadius(config.defaultPlayerMass);
            var position = config.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(users, radius) : util.randomPosition(radius);

            player.x = position.x;
            player.y = position.y;
            player.target.x = 0;
            player.target.y = 0;
            player.cells = [{
                mass: config.defaultPlayerMass,
                x: position.x,
                y: position.y,
                radius: radius
            }];
            player.massTotal = config.defaultPlayerMass;
            player.hue = Math.round(Math.random() * 360);
            currentPlayer = player;
            currentPlayer.lastHeartbeat = new Date().getTime();
            users.push(currentPlayer);

            io.emit('playerJoin', { name: currentPlayer.name });

            console.log('Total players: ' + users.length);
        }

    });

    socket.on('pingcheck', () => {
        socket.emit('pongcheck');
    });

    socket.on('windowResized', (data) => {
        currentPlayer.screenWidth = data.screenWidth;
        currentPlayer.screenHeight = data.screenHeight;
    });

    socket.on('respawn', () => {
        if (util.findIndex(users, currentPlayer.id) > -1)
            users.splice(util.findIndex(users, currentPlayer.id), 1);
        socket.emit('welcome', currentPlayer, {
            width: config.gameWidth,
            height: config.gameHeight
        });
        console.log('[INFO] User ' + currentPlayer.name + ' has respawned');
    });

    socket.on('disconnect', () => {
        if (util.findIndex(users, currentPlayer.id) > -1)
            users.splice(util.findIndex(users, currentPlayer.id), 1);
        console.log('[INFO] User ' + currentPlayer.name + ' has disconnected');

        socket.broadcast.emit('playerDisconnect', { name: currentPlayer.name });
    });

    socket.on('playerChat', (data) => {
        var _sender = data.sender.replace(/(<([^>]+)>)/ig, '');
        var _message = data.message.replace(/(<([^>]+)>)/ig, '');

        if (config.logChat === 1) {
            console.log('[CHAT] [' + (new Date()).getHours() + ':' + (new Date()).getMinutes() + '] ' + _sender + ': ' + _message);
        }

        socket.broadcast.emit('serverSendPlayerChat', {
            sender: _sender,
            message: _message.substring(0, 35)
        });

        chatRepository.logChatMessage(_sender, _message, currentPlayer.ipAddress)
            .catch((err) => console.error("Error when attempting to log chat message", err));
    });

    socket.on('pass', async (data) => {
        const password = data[0];
        if (password === config.adminPass) {
            console.log('[ADMIN] ' + currentPlayer.name + ' just logged in as an admin.');
            socket.emit('serverMSG', 'Welcome back ' + currentPlayer.name);
            socket.broadcast.emit('serverMSG', currentPlayer.name + ' just logged in as an admin.');
            currentPlayer.admin = true;
        } else {
            console.log('[ADMIN] ' + currentPlayer.name + ' attempted to log in with incorrect password.');

            socket.emit('serverMSG', 'Password incorrect, attempt logged.');

            loggingRepositry.logFailedLoginAttempt(currentPlayer.name, currentPlayer.ipAddress)
                .catch((err) => console.error("Error when attempting to log failed login attempt", err));
        }
    });

    socket.on('kick', (data) => {
        if (!currentPlayer.admin) {
            socket.emit('serverMSG', 'You are not permitted to use this command.');
            return;
        }

        var reason = '';
        var worked = false;
        for (var e = 0; e < users.length; e++) {
            if (users[e].name === data[0] && !users[e].admin && !worked) {
                if (data.length > 1) {
                    for (var f = 1; f < data.length; f++) {
                        if (f === data.length) {
                            reason = reason + data[f];
                        }
                        else {
                            reason = reason + data[f] + ' ';
                        }
                    }
                }
                if (reason !== '') {
                    console.log('[ADMIN] User ' + users[e].name + ' kicked successfully by ' + currentPlayer.name + ' for reason ' + reason);
                }
                else {
                    console.log('[ADMIN] User ' + users[e].name + ' kicked successfully by ' + currentPlayer.name);
                }
                socket.emit('serverMSG', 'User ' + users[e].name + ' was kicked by ' + currentPlayer.name);
                sockets[users[e].id].emit('kick', reason);
                sockets[users[e].id].disconnect();
                users.splice(e, 1);
                worked = true;
            }
        }

        if (!worked) {
            socket.emit('serverMSG', 'Could not locate user or user is an admin.');
        }
    });

    // Heartbeat function, update everytime.
    socket.on('0', (target) => {
        currentPlayer.lastHeartbeat = new Date().getTime();
        if (target.x !== currentPlayer.x || target.y !== currentPlayer.y) {
            currentPlayer.target = target;
        }
    });

    socket.on('1', function () {
        // Fire food.
        for (let i = 0; i < currentPlayer.cells.length; i++) {
            if (currentPlayer.cells[i].mass >= config.defaultPlayerMass + config.fireFood) {
                currentPlayer.cells[i].mass -= config.fireFood;
                currentPlayer.massTotal -= config.fireFood;
                map.massFood.addNew(currentPlayer, i, config.fireFood);
            }
        }
    });

    socket.on('2', (virusCell) => {
        const splitCell = (cell) => {
            if (cell && cell.mass && cell.mass >= config.defaultPlayerMass * 2) {
                cell.mass = cell.mass / 2;
                cell.radius = util.massToRadius(cell.mass);
                currentPlayer.cells.push({
                    mass: cell.mass,
                    x: cell.x,
                    y: cell.y,
                    radius: cell.radius,
                    speed: 25
                });
            }
        };

        if (currentPlayer.cells.length < config.limitSplit && currentPlayer.massTotal >= config.defaultPlayerMass * 2) {
            // Split single cell from virus
            if (virusCell) {
                splitCell(currentPlayer.cells[virusCell]);
            }
            else {
                // Split all cells
                if (currentPlayer.cells.length < config.limitSplit && currentPlayer.massTotal >= config.defaultPlayerMass * 2) {
                    const currentPlayersCells = currentPlayer.cells;
                    for (let i = 0; i < currentPlayersCells.length; i++) {
                        splitCell(currentPlayersCells[i]);
                    }
                }
            }

            currentPlayer.lastSplit = new Date().getTime();
        }
    });
}

const addSpectator = (socket) => {
    socket.on('gotit', function () {
        sockets[socket.id] = socket;
        spectators.push(socket.id);
        io.emit('playerJoin', { name: '' });
    });

    socket.emit("welcome", {}, {
        width: config.gameWidth,
        height: config.gameHeight
    });
}

const tickPlayer = (currentPlayer) => {
    if (currentPlayer.lastHeartbeat < new Date().getTime() - config.maxHeartbeatInterval) {
        sockets[currentPlayer.id].emit('kick', 'Last heartbeat received over ' + config.maxHeartbeatInterval + ' ago.');
        sockets[currentPlayer.id].disconnect();
    }

    playerLogic.movePlayer(currentPlayer);

    const funcFood = (f) => {
        return SAT.pointInCircle(new Vector(f.x, f.y), playerCircle);
    };

    const eatMass = (m, currentCell) => {
        if (SAT.pointInCircle(new Vector(m.x, m.y), playerCircle)) {
            if (m.id == currentPlayer.id && m.speed > 0 && z == m.num)
                return false;
            if (currentCell.mass > m.mass * 1.1)
                return true;
        }

        return false;
    };

    const check = (user, currentCell, playerCollisions) => {
        for (let i = 0; i < user.cells.length; i++) {
            if (user.cells[i].mass >= 10 && user.id !== currentPlayer.id) {
                const response = new SAT.Response();
                const hasCollided = SAT.testCircleCircle(playerCircle,
                    new Circle(new Vector(user.cells[i].x, user.cells[i].y), user.cells[i].radius),
                    response);

                if (hasCollided) {
                    response.aUser = currentCell;
                    response.bUser = {
                        id: user.id,
                        name: user.name,
                        x: user.cells[i].x,
                        y: user.cells[i].y,
                        num: i,
                        mass: user.cells[i].mass
                    };

                    playerCollisions.push(response);
                }
            }
        }
        return true;
    };

    const collisionCheck = (collision) => {
        if (collision.aUser.mass > collision.bUser.mass * 1.1 && collision.aUser.radius > Math.sqrt(Math.pow(collision.aUser.x - collision.bUser.x, 2) + Math.pow(collision.aUser.y - collision.bUser.y, 2)) * 1.75) {
            console.log('[DEBUG] Killing user: ' + collision.bUser.id);
            console.log('[DEBUG] Collision info:');
            console.log(collision);

            const userIndex = util.findIndex(users, collision.bUser.id);
            if (userIndex > -1) {
                if (users[userIndex].cells.length > 1) {
                    users[userIndex].massTotal -= collision.bUser.mass;
                    users[userIndex].cells.splice(collision.bUser.num, 1);
                } else {
                    users.splice(userIndex, 1);
                    io.emit('playerDied', {
                        playerEatenName: collision.bUser.name,
                        // TODO: Implement aUser name.
                        //playerWhoAtePlayerName: collision.aUser.name,
                    });
                    sockets[collision.bUser.id].emit('RIP');
                }
            }
            currentPlayer.massTotal += collision.bUser.mass;
            collision.aUser.mass += collision.bUser.mass;
        }
    };

    for (var z = 0; z < currentPlayer.cells.length; z++) {
        const currentCell = currentPlayer.cells[z];

        playerCircle = new Circle(
            new Vector(currentCell.x, currentCell.y),
            currentCell.radius
        );

        const foodEaten = map.food.data.map(funcFood)
            .reduce(function (a, b, c) { return b ? a.concat(c) : a; }, []);

        map.food.delete(foodEaten);

        const massEaten = map.massFood.data.map((f) => eatMass(f, currentCell))
            .reduce(function (a, b, c) { return b ? a.concat(c) : a; }, []);

        const virusCollision = map.viruses.data.map(funcFood)
            .reduce(function (a, b, c) { return b ? a.concat(c) : a; }, []);

        if (virusCollision > 0 && currentCell.mass > map.viruses.data[virusCollision].mass) {
            sockets[currentPlayer.id].emit('virusSplit', z);
            map.viruses.delete(virusCollision)
        }

        let massGained = 0;
        for (let index of massEaten) { //massEaten is an array of indexes -> "index of" instead of "index in" is intentional
            massGained += map.massFood.data[index].mass;
        }

        map.massFood.remove(massEaten);

        if (typeof (currentCell.speed) == "undefined") {
            currentCell.speed = 6.25;
        }

        massGained += (foodEaten.length * config.foodMass);
        currentCell.mass += massGained;
        currentPlayer.massTotal += massGained;
        currentCell.radius = util.massToRadius(currentCell.mass);
        playerCircle.r = currentCell.radius;

        tree.clear();
        users.forEach(tree.put);
        let playerCollisions = [];

        tree.get(currentPlayer, (u) => check(u, currentCell, playerCollisions));

        playerCollisions.forEach(collisionCheck);
    }
};

const moveloop = () => {
    for (let i = 0; i < users.length; i++) {
        tickPlayer(users[i]);
    }
    map.massFood.move();
};

const gameloop = () => {
    if (users.length > 0) {
        users.sort((a, b) => {
            return b.massTotal - a.massTotal;
        });

        const topUsers = [];

        for (let i = 0; i < Math.min(10, users.length); i++) {
            if (users[i].type == 'player') {
                topUsers.push({
                    id: users[i].id,
                    name: users[i].name
                });
            }
        }

        if (isNaN(leaderboard) || leaderboard.length !== topUsers.length) {
            leaderboard = topUsers;
            leaderboardChanged = true;
        }
        else {
            for (let i = 0; i < leaderboard.length; i++) {
                if (leaderboard[i].id !== topUsers[i].id) {
                    leaderboard = topUsers;
                    leaderboardChanged = true;
                    break;
                }
            }
        }

        for (let i = 0; i < users.length; i++) {
            for (var j = 0; j < users[i].cells.length; j++) {
                if (users[i].cells[j].mass * (1 - (config.massLossRate / 1000)) > config.defaultPlayerMass && users[i].massTotal > config.minMassLoss) {
                    var massLoss = users[i].cells[j].mass * (1 - (config.massLossRate / 1000));
                    users[i].massTotal -= users[i].cells[j].mass - massLoss;
                    users[i].cells[j].mass = massLoss;
                }
            }
        }
    }

    gameLogic.balanceMass(map.food, map.viruses, users);
};

const sendUpdates = () => {
    spectators.forEach(updateSpectator)
    users.forEach((u) => {
        var visibleFood = map.food.data
            .filter(function (f) {
                return util.testSquareRectangle(
                    f.x, f.y, 0,
                    u.x, u.y, u.screenWidth / 2 + 20, u.screenHeight / 2 + 20);
            });

        var visibleVirus = map.viruses.data
            .filter(function (f) {
                return util.testSquareRectangle(
                    f.x, f.y, 0,
                    u.x, u.y, u.screenWidth / 2 + f.radius, u.screenHeight / 2 + f.radius);
            });

        var visibleMass = map.massFood.data
            .filter(function (f) {
                return util.testSquareRectangle(
                    f.x, f.y, f.radius,
                    u.x, u.y, u.screenWidth / 2 + 20, u.screenHeight / 2 + 20);
            });


        const visibleCells = users
            .map((f) => {
                for (let cell of f.cells) {
                    if (util.testSquareRectangle(
                        cell.x, cell.y, cell.radius,
                        u.x, u.y, u.screenWidth / 2 + 20, u.screenHeight / 2 + 20)) {
                        if (f.id !== u.id) {
                            return {
                                id: f.id,
                                x: f.x,
                                y: f.y,
                                cells: f.cells,
                                massTotal: Math.round(f.massTotal),
                                hue: f.hue,
                                name: f.name
                            };
                        } else {
                            return {
                                x: f.x,
                                y: f.y,
                                cells: f.cells,
                                massTotal: Math.round(f.massTotal),
                                hue: f.hue,
                            };
                        }
                    }
                }
            })
            .filter((f) => f);

        sockets[u.id].emit('serverTellPlayerMove', u, visibleCells, visibleFood, visibleMass, visibleVirus);

        if (leaderboardChanged) {
            sendLeaderboard(sockets[u.id]);
        }
    });

    leaderboardChanged = false;
};

const sendLeaderboard = (socket) => {
    socket.emit('leaderboard', {
        players: users.length,
        leaderboard
    });
}
const updateSpectator = (socketID) => {
    let playerData = {
        x: config.gameWidth / 2,
        y: config.gameHeight / 2,
        cells: [],
        massTotal: 0,
        hue: 100,
        id: socketID,
        name: ''
    };
    sockets[socketID].emit('serverTellPlayerMove', playerData, users, map.food.data, map.massFood.data, map.viruses.data);
    if (leaderboardChanged) {
        sendLeaderboard(sockets[socketID]);
    }
}

setInterval(moveloop, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / config.networkUpdateFactor);

// Don't touch, IP configurations.
var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || config.host;
var serverport = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || config.port;
http.listen(serverport, ipaddress, () => console.log('[DEBUG] Listening on ' + ipaddress + ':' + serverport));
