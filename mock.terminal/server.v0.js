
// verifone-mock-server.js

const net = require('net');

const PORT = process.argv[2] || 8081;

const ECR_ID = process.argv[3] || '13';

const STX = 0x02, LF = 0x0A, ETX = 0x03;

// Frame the response

function frame(obj) {

    const j = Buffer.from(JSON.stringify(obj), 'ascii');

    return Buffer.concat([Buffer.from([STX, LF]), j, Buffer.from([LF, ETX, LF])]);

}

// Helper to strip framing

const strip = b => b.toString('ascii').replace(/[\x02\x03\x0A\x0D\x00]/g, '').trim();

const server = net.createServer(socket => {

    console.log('== CLIENT CONNECTED ==');

    let acc = Buffer.alloc(0);

    socket.on('data', chunk => {

        acc = Buffer.concat([acc, chunk]);

        while (true) {

            const s = acc.indexOf(STX), e = acc.indexOf(ETX, s + 1);

            if (s === -1 || e === -1) break;

            const raw = acc.slice(s + 1, e);

            const text = strip(raw);

            console.log('>> RECEIVED:', text);

            try {

                const obj = JSON.parse(text);

                if (obj.message === 'MSG' && obj.data?.command === 'Ping') {

                    const reqId = obj.data.requestId || '000000';

                    const ecr = obj.data.EcrId || '';

                    // Send ACK

                    const ack = frame({ message: 'ACK', data: '' });

                    socket.write(ack);

                    console.log('<< SENT: ACK');

                    // Delay a bit and send the Ping MSG response

                    setTimeout(() => {

                        const res = {

                            message: 'MSG',

                            data: {

                                cmdResult: {

                                    result: ecr === ECR_ID ? 'Success' : 'Failed',

                                    errorCode: ecr === ECR_ID ? undefined : 'ERR100'

                                },

                                response: 'Ping',

                                EcrId: ecr,

                                requestId: reqId

                            }

                        };

                        socket.write(frame(res));

                        console.log('<< SENT: Ping MSG');

                    }, 500);

                }

                if (obj.message === 'ACK') {

                    console.log('>> RECEIVED FINAL ACK');

                }

            } catch (err) {

                console.log('!! PARSE ERROR:', err.message);

            }

            acc = acc.slice(e + 1);

        }

    });

    socket.on('close', () => {

        console.log('== CLIENT DISCONNECTED ==');

    });

    socket.on('error', err => {

        console.error('!! SOCKET ERROR:', err.message);

    });

});

server.listen(PORT, () => {

    console.log(`== MOCK VERIFONE SERVER RUNNING on port ${PORT} (ECR_ID=${ECR_ID}) ==`);

});

