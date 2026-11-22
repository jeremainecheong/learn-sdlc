/**
 * A stored zip, written a header at a time.
 *
 * A CRC-32 table built once at module load, an MS-DOS time stamp, and the
 * local file header, central directory and end-of-central-directory layout,
 * with the entries handed out one at a time so the API can write them into a
 * response instead of building the archive whole.
 *
 * The archive is stored, not deflated.
 * No compression means no dependency, and the loose objects inside are already
 * zlib streams, so deflating them a second time would buy nothing.
 */

/* CRC-32, the one checksum a zip reader insists on. The table is built once. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, the format the zip headers were born with. */
export function dosStamp(now: Date): { time: number; date: number } {
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date: ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

/** One file in the archive, remembered so the central directory can find it. */
export interface ZipEntry {
  name: Buffer;
  sum: number;
  size: number;
  offset: number;
}

export function localHeader(path: string, body: Buffer, stamp: { time: number; date: number }): {
  header: Buffer;
  entry: Omit<ZipEntry, 'offset'>;
} {
  const name = Buffer.from(path, 'utf8');
  const sum = crc32(body);
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0); // local file header
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(0, 8); // stored, not deflated
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(sum, 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  name.copy(header, 30);
  return { header, entry: { name, sum, size: body.length } };
}

export function centralHeader(entry: ZipEntry, stamp: { time: number; date: number }): Buffer {
  const out = Buffer.alloc(46 + entry.name.length);
  out.writeUInt32LE(0x02014b50, 0); // central directory header
  out.writeUInt16LE(20, 4); // version made by
  out.writeUInt16LE(20, 6); // version needed
  out.writeUInt16LE(0x0800, 8);
  out.writeUInt16LE(0, 10);
  out.writeUInt16LE(stamp.time, 12);
  out.writeUInt16LE(stamp.date, 14);
  out.writeUInt32LE(entry.sum, 16);
  out.writeUInt32LE(entry.size, 20);
  out.writeUInt32LE(entry.size, 24);
  out.writeUInt16LE(entry.name.length, 28);
  out.writeUInt32LE(entry.offset, 42);
  entry.name.copy(out, 46);
  return out;
}

export function endOfCentralDirectory(count: number, dirSize: number, dirOffset: number): Buffer {
  const out = Buffer.alloc(22);
  out.writeUInt32LE(0x06054b50, 0); // end of central directory
  out.writeUInt16LE(count, 8);
  out.writeUInt16LE(count, 10);
  out.writeUInt32LE(dirSize, 12);
  out.writeUInt32LE(dirOffset, 16);
  return out;
}
