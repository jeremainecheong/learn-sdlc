import {
  centralHeader,
  crc32,
  dosStamp,
  endOfCentralDirectory,
  localHeader,
  type ZipEntry,
} from './zip';

/**
 * A zip reader written in the spec, so the archive is checked
 * against the format rather than against the writer agreeing with itself.
 */
function archive(files: { path: string; body: Buffer }[], now: Date): Buffer {
  const stamp = dosStamp(now);
  const parts: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let at = 0;
  for (const file of files) {
    const { header, entry } = localHeader(file.path, file.body, stamp);
    entries.push({ ...entry, offset: at });
    parts.push(header, file.body);
    at += header.length + file.body.length;
  }
  const dirOffset = at;
  let dirSize = 0;
  for (const entry of entries) {
    const header = centralHeader(entry, stamp);
    dirSize += header.length;
    parts.push(header);
  }
  parts.push(endOfCentralDirectory(entries.length, dirSize, dirOffset));
  return Buffer.concat(parts);
}

/** Walks an archive the way a zip reader does: end record, directory, bodies. */
export function walkZip(zip: Buffer): { name: string; body: Buffer }[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 8);
  const dirSize = zip.readUInt32LE(end + 12);
  const dirOffset = zip.readUInt32LE(end + 16);
  expect(dirOffset + dirSize).toBe(end);

  const out: { name: string; body: Buffer }[] = [];
  let at = dirOffset;
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    const size = zip.readUInt32LE(at + 24);
    const sum = zip.readUInt32LE(at + 16);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + size);
    expect(crc32(body)).toBe(sum);
    out.push({ name, body });
    at += 46 + nameLength;
  }
  return out;
}

describe('the stored zip writer', () => {
  const now = new Date('2026-03-12T09:14:00.000Z');

  it('builds an archive one reader can walk', () => {
    const zip = archive(
      [
        { path: 'README.md', body: Buffer.from('# TaskTrackr\n') },
        { path: '.git/HEAD', body: Buffer.from('ref: refs/heads/main\n') },
      ],
      now,
    );
    const walked = walkZip(zip);
    expect(walked.map((entry) => entry.name)).toEqual(['README.md', '.git/HEAD']);
    expect(walked[0].body.toString('utf8')).toBe('# TaskTrackr\n');
    expect(walked[1].body.toString('utf8')).toBe('ref: refs/heads/main\n');
  });

  it('stamps every entry from the date it is given, so two exports are byte-identical', () => {
    const files = [{ path: 'README.md', body: Buffer.from('# TaskTrackr\n') }];
    expect(archive(files, now).equals(archive(files, now))).toBe(true);
    // A different newest commit is a different archive, which is the point of
    // taking the stamp from the history rather than from the clock.
    expect(archive(files, now).equals(archive(files, new Date('2026-03-13T09:14:00.000Z')))).toBe(
      false,
    );
  });
});
