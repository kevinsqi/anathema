import React from "react";
import { Button } from "react-bootstrap";

import io from "socket.io-client";

function App() {
  const [socket, setSocket] = React.useState(null);

  React.useEffect(() => {
    const newSocket = io.connect("http://localhost:3001");
    setSocket(newSocket);
  }, []);

  return (
    <div>
      <h1>Anathema</h1>
      {socket && (
        <Button
          variant="primary"
          onClick={() => {
            socket.emit("lobby:create", {}, (result) => {
              console.log("lobby:create", result);
            });
          }}
        >
          Create lobby
        </Button>
      )}
    </div>
  );
}

export default App;
