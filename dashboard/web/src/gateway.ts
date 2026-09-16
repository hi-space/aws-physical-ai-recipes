import { createGatewayServer } from './server/gateway';
import { getDcvUpstream, closeDcvTunnels } from './server/dcv/tunnel';

const server = createGatewayServer({ getDcvUpstream });
server.listen(3002, '0.0.0.0');
server.on('error', () => {
  // No request URLs, tokens, upstream errors, AWS responses, or connection headers in logs.
  process.stderr.write('Session gateway listener failed\n');
  process.exitCode = 1;
});
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void closeDcvTunnels();
    server.close(() => { process.exitCode = 0; });
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
  });
}
