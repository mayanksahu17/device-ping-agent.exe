function sendPing() {
  document.getElementById("logArea").innerText = "Sending Ping to Port 8081...";
  fetch("http://localhost:3000/ping")
    .then(res => res.json())
    .then(data => {
      document.getElementById("logArea").innerText = JSON.stringify(data, null, 2);
    })
    .catch(err => {
      document.getElementById("logArea").innerText = "Error: " + err.message;
    });
}

function sendPingalt() {
  document.getElementById("logArea").innerText = "Sending Ping to Port 8080...";
  fetch("http://localhost:3000/ping_alt")
    .then(res => res.json())
    .then(data => {
      document.getElementById("logArea").innerText = JSON.stringify(data, null, 2);
    })
    .catch(err => {
      document.getElementById("logArea").innerText = "Error: " + err.message;
    });
}
