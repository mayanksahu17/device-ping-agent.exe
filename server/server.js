const express = require("express");
const net = require("net");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

const TERMINAL_IP = "192.168.1.91";
let TERMINAL_PORT = 8081;
let TERMINAL_PORT_ALT = 8081;
const ECR_ID = "13";

const LOG_FILE = path.join(__dirname, "terminal-requests.log");

function logEvent(label, data) {
  const logLine = `[${new Date().toISOString()}] [${label}] ${data}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
  console.log(logLine.trim());
}

function unframeMessage(raw) {
  return raw.toString().replace(/\x02|\x0A|\x03/g, "").trim();
}

function createPingHandler(port) {
  return (req, res) => {
    const client = new net.Socket();
    const requestId = Date.now().toString();

    const payload = {
      message: "MSG",
      data: {
        command: "Ping",
        EcrId: ECR_ID,
        requestId,
      },
    };

    const framed = `\x02\x0A${JSON.stringify(payload)}\x0A\x03`;

    logEvent("REQUEST_START", `Ping to ${TERMINAL_IP}:${port} (requestId=${requestId})`);
    logEvent("REQUEST_PAYLOAD", JSON.stringify(payload));
    logEvent("REQUEST_FRAMED", JSON.stringify(framed));

    client.setTimeout(5000);

    client.connect(port, TERMINAL_IP, () => {
      logEvent("TCP_CONNECT", `Connected to ${TERMINAL_IP}:${port}`);
      client.write(framed);
    });

    client.on("data", (data) => {
      logEvent("RAW_RESPONSE", JSON.stringify(data.toString()));
      const response = unframeMessage(data);
      logEvent("PARSED_RESPONSE", response);
      res.json({ success: true, requestId, response });
      client.destroy();
    });

    client.on("timeout", () => {
      logEvent("TIMEOUT", `No response within timeout for requestId=${requestId}`);
      res.json({ success: false, requestId, message: "Timeout" });
      client.destroy();
    });

    client.on("error", (err) => {
      logEvent("ERROR", `Error for requestId=${requestId}: ${err.message}`);
      res.json({ success: false, requestId, message: err.message });
      client.destroy();
    });
  };
}

app.get("/ping", createPingHandler(TERMINAL_PORT));
app.get("/ping_alt", createPingHandler(TERMINAL_PORT_ALT));

app.listen(PORT, () => {
  console.log(`Agent server running at http://localhost:${PORT}`);
  logEvent("SERVER_START", `Listening on port ${PORT}`);
});
