import React from "react";
import { Button } from "react-bootstrap";

import io from "socket.io-client";

function App() {
  const [socket, setSocket] = React.useState(null);
  const [lobby, setLobby] = React.useState(null);

  React.useEffect(() => {
    const newSocket = io.connect("http://localhost:3001");
    setSocket(newSocket);

    newSocket.on("lobby:update", (result) => {
      console.log("lobby:update", result);
      setLobby(result);
    });

    // TODO: close socket on unmount
  }, []);

  if (!socket) {
    return <div>Loading...</div>;
  }

  if (lobby) {
    return (
      <div>
        <h1>Anathema - Lobby {lobby.lobbyCode}</h1>
        <ul>
          {lobby.players.map((id) => {
            return <li key={id}>{id}</li>;
          })}
        </ul>
      </div>
    );
  }

  return (
    <div>
      <h1>Anathema</h1>
      <Button
        variant="primary"
        onClick={() => {
          socket.emit("lobby:create", {}, (result) => {
            console.log("lobby:create", result);
            setLobby(result);
          });
        }}
      >
        Create lobby
      </Button>

      <JoinLobbyForm socket={socket} setLobby={setLobby} />
    </div>
  );
}

function JoinLobbyForm({ socket, setLobby }) {
  const [lobbyCode, setLobbyCode] = React.useState("");
  return (
    <div>
      <input
        type="text"
        value={lobbyCode}
        onChange={(event) => setLobbyCode(event.target.value)}
      />
      <Button
        variant="primary"
        onClick={() => {
          socket.emit("lobby:join", { lobbyCode }, (err, result) => {
            console.log("lobby:join", result);
            if (err) {
              // TODO: display error
              console.error(err);
              return;
            }
            setLobby(result);
          });
        }}
      >
        Join lobby
      </Button>
    </div>
  );
}

export default App;
