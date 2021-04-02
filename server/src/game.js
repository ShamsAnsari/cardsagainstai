const { v4: uuidv4 } = require('uuid');

const { createPlayer } = require('./Player');

function Game(goal, name, maxPlayers) {
  this.gameId = uuidv4();
  this.name = name;
  this.goal = goal;
  this.maxPlayers = maxPlayers;
  this.state = 0; // PLAYING 1, JUDGING 2, IDLE 0
  this.czar = null; // Player object
  this.players = new Map(); // playerId: Player ! Need order of insertion
  // gathered black cards,totalRounds = 41 (for numPlayers = 10, targetPoints = 5)
  this.questionCards = []; // number (cardId) | Array
  // gathered white cards, num_players * totalRounds = 469 total
  this.answerCards = []; // number (cardId) | Array
  this.board = {
    currentAnswerCards: [], // number (cardId) | Array
    currentAnswerCardsMap: {}, // object {cardId: playerId}
    currentQuestionCard: null, // card object
    turnNum: 0,
  };
  this.timestamp = new Date();
}

function omit(obj, ...props) {
  const result = { ...obj };
  props.forEach((prop) => {
    delete result[prop];
  });
  return result;
}

/**
 * Game loop
 * TODO can't use loops!
 */
Game.prototype.start = function (redis) {
  if (this.players.size <= 2) {
    throw new Error("Not enough players. Can't start game");
  }

  if (this.state !== 0) {
    throw new Error('Game in progress.');
  }
  // 1. Load appropriate number of cards from DB
  const fullHandSize = 10;
  const numPlayers = Object.keys(this.players).length;
  const targetPoints = 5;
  const totalRounds = numPlayers * (targetPoints - 1) + targetPoints;
  const numWhiteCards = numPlayers * totalRounds;
  this.board.questionCards = redis.getQuestionCards(totalRounds, true);
  this.board.answerCards = redis.getAnswerCards(numWhiteCards, true);

  // 2. Deal cards to board and players
  // console.log("BOARD: " + JSON.stringify(this.board, undefined, 2))
  this.board.currentQuestionCard = this.board.questionCards.pop();
  this.players = this.replenishHand(this.players, fullHandSize);
  // 3. Pick Czar
  this.pickCzar();
  // TODO: Turn state to collecting answers

  // 5. wait for all player to play a card (except Czar): handleSelect
  // 6. updateBoard // show all played white Cards
  // 7. Turn to state to judging
  // 8. Wait for Czar: handlePickWinningCard
  // 9. Clean Board // removes all black and  white cards
  // 10. updatePlayerList
  // 11. loop Back
};

/**
 * Picks a czar for the current round
 * @returns
 */
Game.prototype.pickCzar = function () {
  const index = this.turnNum % this.players.size;
  const player = Array.from(this.players.values())[index];
  player.status = 2;
  this.czar = player.id;
};

/**
 * Deals cards to players until they have fullHandSize cards
 * @param fullHandSize Number of cards to replenish to
 * @returns map of players
 */
Game.prototype.replenishHand = function (fullHandSize) {
  Array.from(this.players.values()).forEach((player) => {
    while (player.hand.length < fullHandSize) {
      player.hand.push(this.answerCards.pop());
    }
  });
};

/**
 * Adds player to the game room
 */
Game.prototype.addPlayer = function () {
  const player = createPlayer();
  this.players.set(player.playerId, player);
  return player;
};

/**
 * Removes currentQuestionCard & currentAnswerCards
 */
Game.prototype.cleanBoard = function () {
  Array.from(this.players.values()).forEach((player) => {
    player.status = 0;
  });
  this.czar = null;
  this.baord.turnNum += 1;
  this.board.currentQuestionCards = [];
  this.board.currentAnswerCards = [];
  this.board.currentAnswerCardsMap = {};
  this.state = 1;
};

/**
 * Sends the current state board to the player
 */
Game.prototype.updateBoard = function () {
  const data = {
    event: 'updateBoard',
    board: this.board,
  };
  Array.from(this.players.values()).forEach((player) => {
    player.ws.send(JSON.stringify(data));
  });
};

/**
 * Update player on information about the game
 * relevant to them (individual)
 */
Game.prototype.updatePlayer = function (ws, id) {
  if (!this.players.get[id]) {
    throw new Error('Not in game');
  }

  const player = omit(this.players.get(id), 'ws');
  const data = {
    event: 'updatePlayer',
    state: this.state,
    czar: this.czar,
    player,
  };
  ws.send(JSON.stringify(data));
};

/**
 * Sends the playerList to all players (Shared data)
 */
Game.prototype.updatePlayerList = function () {
  const playerList = Array.from(this.players.values());
  const filteredPlayerList = playerList.map((player) =>
    omit(player, 'hand', 'ws', 'playerId')
  );
  const data = {
    event: 'updatePlayerList',
    filteredPlayerList,
  };
  playerList.forEach((player) => player.ws.send(JSON.stringify(data)));
};

/**
 * Add new player and update other players
 * @returns boolean
 */
Game.prototype.handleJoin = function (ws, host) {
  let player = createPlayer(ws);
  player = omit(player, 'ws');

  player.host = host;
  ws.send(
    JSON.stringify({
      event: 'joinGame',
      status: '200',
      player,
      game: {
        gameId: this.gameId,
        name: this.name,
        goal: this.goal,
        czar: this.czar,
        maxPlayers: this.maxPlayers,
        state: this.state,
        board: this.board,
      },
    })
  );
  this.updatePlayerList();
};

/**
 * Check if all players (except czar) have played a card
 * 	@returns boolean
 */
Game.prototype.checkAllPlayers = function () {
  for (const player in this.players) {
    if (player.status === 0) {
      return false;
    }
  }
  return true;
};

Game.prototype.refundCards = function () {
  const { players } = this;
  Object.entries(this.currentAnswerCardsMap).forEach((cardId, playerId) => {
    players.get(playerId).hand.push(cardId);
  });
};

/**
 * Removes player and update other players
 * @returns boolean
 */
Game.prototype.handleLeave = function (ws, playerId) {
  const player = this.players.get(playerId);
  if (!player) {
    throw new Error('not in game');
  }
  const { status } = player;
  this.players.delete(playerId);
  this.updatePlayerList();
  ws.send(
    JSON.stringify({
      event: 'leave',
      status: '200',
    })
  );

  if (status === 1) {
    const [cid, pid] = Object.entries(this.currentAnswerCardsMap).find((arr) =>
      arr.includes(playerId)
    );
    this.currentAnswerCardsMap.delete(cid);
    this.updateBoard();
  } else if (status === 2) {
    console.log('Czar leaving');
    ws.send({
      event: 'broadcast message',
      message: 'Czar left the game. Refunding cards.',
    });
    this.cleanBoard();
    this.updateBoard();
    // TODO Restart new turn
    this.start();
  }
};

/**
 * Handles player card selction
 */
Game.prototype.handleSelect = function (playerId, cardId) {
  const player = this.players.get(playerId);
  if (player.status === 0 && player.hand.includes(cardId)) {
    // Card not selected
    this.board.currentAnswerCardsMap[cardId] = playerId;
    const cardIndex = player.hand.indexOf(cardId);
    player.hand.splice(cardIndex, 1);
    console.log(`Selected card ${cardId} with index ${cardIndex}`);
    player.status = 1;
  } else {
    // Already submitted or czar
    throw new Error('Invalid Operation');
  }
};

/**
 * Handles czar card selection && increment player score
 * @returns boolean
 */
Game.prototype.handlePickWinningCard = function (playerId, cardId) {
  const player = this.players.get(playerId);
  if (player.status === 2 && this.currentAnswerCards.includes(cardId)) {
    const winner = this.currentAnswerCardsMap[cardId];
    winner.score += 1;
  } else {
    // Not czar or card is not in play
    throw new Error('Invalid Operation');
  }
};
/**
 * shuffles the deck of cards
 */
function shuffle(array) {
  let currentIndex = array.length;
  let temporaryValue;
  let randomIndex;

  // While there remain elements to shuffle
  while (currentIndex !== 0) {
    // Pick a remaining element
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    // And swap it with the current element
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }

  return array;
}

function getHighestScore(players) {
  let score = -1;
  for (const player in players) {
    if (player.score > score) {
      score = player.score;
    }
  }
  return score;
}

/**
 * Factory method for Game
 * @returns Game object
 */
function initializeGame(goal, name, maxPlayers) {
  const game = new Game(goal, name, maxPlayers);
  return game;
}

module.exports = {
  initializeGame,
};