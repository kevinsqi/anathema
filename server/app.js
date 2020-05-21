const server = require("http").createServer();

const io = require("socket.io")(server);

let state = {
  lobbies: {},
};

io.on("connection", (client) => {
  console.log("Client connected:", client.id);

  client.on("lobby:create", (data, callback) => {
    console.log("lobby:create", data);
    const lobbyCode = Math.random().toString();
    const lobby = {
      lobbyCode,
      players: [client.id],
    };
    state.lobbies[lobbyCode] = lobby;
    callback(lobby);
  });

  client.on("lobby:join", (lobbyCode) => {
    console.log(`[join] ${client.id} joining lobby ${lobbyCode}`);
  });

  // TODO: disconnect, error handlers
});

const port = 3001;

server.listen(port, (error) => {
  if (error) {
    throw error;
  }
  console.log(`Listening on port ${port}...`);
});
