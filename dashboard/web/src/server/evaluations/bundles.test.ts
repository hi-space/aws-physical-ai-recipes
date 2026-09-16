import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { directoryManifest, inspectCheckpointTar } from './bundles';
import { sha, tarFixture } from './pipeline-fixtures';

describe('typed directory versus full-file checkpoint digests', () => {
  it.each(['USTAR_FORMAT', 'PAX_FORMAT', 'GNU_FORMAT'])('inspects real %s tar bytes and agrees with the recipe adapter', async format => {
    const files = { 'config.json': '{}', 'weights/model.bin': 'fixture-weights', '한글.txt': 'unicode' };
    if (format === 'USTAR_FORMAT') delete (files as Partial<typeof files>)['한글.txt'];
    const tar = tarFixture(files, format);
    const actual = await inspectCheckpointTar(Readable.from([tar.subarray(0, 17), tar.subarray(17)]));
    const expected = directoryManifest(Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) })));
    expect(actual).toEqual(expected);
    expect(actual.digest).not.toBe(sha(tar));
    const recipe = execFileSync('python3', ['-c', `
import json,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from checkpoint_bundle import inspect_checkpoint
with tempfile.TemporaryDirectory() as root:
 path=Path(root)/"model.tar.gz";path.write_bytes(sys.stdin.buffer.read())
 print(json.dumps(inspect_checkpoint(path)[1]))
`, resolve('../recipes')], { input: tar }).toString();
    expect(JSON.parse(recipe)).toEqual(actual);
  });
  it('supports GNU long filenames and PAX metadata without confusing them with model files', async () => {
    const path = 'folder/'.repeat(18) + 'model.bin';
    for (const format of ['GNU_FORMAT', 'PAX_FORMAT']) {
      const actual = await inspectCheckpointTar(Readable.from([tarFixture({ [path]: 'weights' }, format)]));
      expect(actual.files).toEqual([{ path, bytes: 7, sha256: sha('weights') }]);
    }
  });
  it.each(['symlink', 'hardlink', 'traversal', 'duplicate', 'fifo', 'collision'])('rejects %s archives instead of manufacturing a bundle', async kind => {
    const bytes = execFileSync('python3', ['-c', `
import io,sys,tarfile
kind=sys.argv[1]
with tarfile.open(fileobj=sys.stdout.buffer,mode="w|gz") as archive:
 item=tarfile.TarInfo("../escape" if kind=="traversal" else "weights")
 if kind in ("symlink","hardlink"):
  item.type=tarfile.SYMTYPE if kind=="symlink" else tarfile.LNKTYPE;item.linkname="/etc/passwd"
 elif kind=="fifo":item.type=tarfile.FIFOTYPE
 else:item.size=1
 archive.addfile(item,io.BytesIO(b"x") if item.isfile() else None)
 if kind in ("duplicate","collision"):
  second=tarfile.TarInfo("weights" if kind=="duplicate" else "weights/child");second.size=1
  archive.addfile(second,io.BytesIO(b"y"))
`, kind]);
    await expect(inspectCheckpointTar(Readable.from([bytes]))).rejects.toThrow();
  });
  it('rejects truncated gzip and tar headers', async () => {
    const tar = tarFixture({ 'model.bin': 'checkpoint' });
    await expect(inspectCheckpointTar(Readable.from([tar.subarray(0, -12)]))).rejects.toThrow();
    await expect(inspectCheckpointTar(Readable.from([Buffer.from('not-gzip')]))).rejects.toThrow();
  });
  it('keeps ambiguous legacy concatenation hashes outside the typed algorithm', () => {
    const one = directoryManifest([{ path: 'a', bytes: 2, sha256: sha('bc') }]);
    const two = directoryManifest([{ path: 'ab', bytes: 1, sha256: sha('c') }]);
    expect(one.digest).not.toBe(two.digest);
    expect(one.algorithm).toBe('pai-directory-sha256-v1');
  });
});
