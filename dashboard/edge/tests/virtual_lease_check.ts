/** Integration: actual backend lease logic -> isolated receiver -> explicit release.
 * AWS and DynamoDB are fakes. Packets are real loopback TCP inside a local container.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, alice } from '../../web/src/app/api/edge/fixtures';

async function main() {
  const data = await fixture();
  data.advance(Date.now() - Date.parse('2026-09-16T00:00:00Z'));
  const device = await data.service.register(alice, 'a', {
    label: 'Isolated lease integration', kind: 'virtual', targetName: 'isolated-lease-integration',
    architecture: 'amd64', physical: false, profiles: [],
  });
  const lease = await data.service.claimLease(alice, 'a', device.id, { runId: 'active-run', ttlSeconds: 60 });
  const folder = await mkdtemp(path.join(tmpdir(), 'edge-lease-'));
  try {
    const file = path.join(folder, 'lease.json');
    await writeFile(file, JSON.stringify(lease), { mode: 0o600 });
    console.log('Lease issued; starting isolated receiver with current epoch', lease.epoch);
    const result = JSON.parse(execFileSync('docker', [
      'run', '--rm', '--network', 'none', '--user', String(process.getuid?.() ?? 1000),
      '--mount', `type=bind,src=${file},dst=/lease.json,readonly`, 'physical-ai-edge-virtual:test',
      'python', '/opt/edge/virtual_device.py', '--self-test', '--lease-file', '/lease.json',
    ], { encoding: 'utf8', timeout: 30_000 }));
    assert.equal(result.type, 'communication');
    assert.equal(result.physicalHardwareTested, false);
    assert.equal(result.deviceId, lease.deviceId);
    assert.equal(result.leaseEpoch, lease.epoch);
    assert.equal(result.messageCount, 10);
    const proof = { runId: lease.runId, epoch: lease.epoch, token: lease.token };
    const validation = await data.service.lease(alice, 'a', device.id, 'validate', proof);
    assert.ok(validation && 'valid' in validation && validation.valid);
    await data.service.lease(alice, 'a', device.id, 'release', proof);
    await assert.rejects(data.service.lease(alice, 'a', device.id, 'validate', proof));
    assert.equal(data.cloud.creates.length, 0);
    console.log('PASS backend lease -> 10 isolated TCP echoes -> release rejects old proof. Communication-only; zero AWS calls.');
  } finally { await rm(folder, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
