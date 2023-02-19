//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2019, 2020 Tom Seddon
// 
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
// 
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with this program. If not, see
// <https://www.gnu.org/licenses/>.
//
//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

import * as utils from './utils';
import * as beebfs from './beebfs';
import * as errors from './errors';
import * as diskimage from './diskimage';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const TRACK_SIZE_SECTORS = 10;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;
const MAX_NUM_TRACKS = 80;

export const DFS_FS = 4;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function checkSize(data: Buffer, minSize: number): void {
    if (data.length < minSize) {
        return errors.generic(`Bad image size (must be >=${minSize})`);
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function getUsedTracks(data: Buffer, track0Offset: number, allSectors: boolean, log: utils.Log | undefined): number[] {
    if (data[track0Offset + 0x105] % 8 !== 0) {
        return errors.generic('Bad DFS format (file count)');
    }

    // const cat0 = Buffer.from(data, track0Offset, SECTOR_SIZE_BYTES);
    // const cat1 = Buffer.from(data, track0Offset + SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES);

    const cat0 = data.subarray(track0Offset, track0Offset + SECTOR_SIZE_BYTES);
    const cat1 = data.subarray(track0Offset + SECTOR_SIZE_BYTES, track0Offset + SECTOR_SIZE_BYTES + SECTOR_SIZE_BYTES);

    if (allSectors) {
        const numSectors = cat1[0x07] | ((cat1[0x06] & 0x03) << 8);

        if (numSectors % TRACK_SIZE_SECTORS !== 0) {
            return errors.generic('Bad DFS format (sector count)');
        }

        const usedTracks: number[] = [];
        for (let index = 0; index < Math.floor(numSectors / TRACK_SIZE_SECTORS); ++index) {
            usedTracks.push(index);
        }

        return usedTracks;
    } else {
        const usedTracksSet = new Set<number>();

        for (let offset = 8; offset <= cat1[0x05]; offset += 8) {
            let size = 0;
            size |= cat1[offset + 4] << 0;
            size |= cat1[offset + 5] << 8;
            size |= (cat1[offset + 6] >> 4 & 3) << 16;

            let startSector = 0;
            startSector |= cat1[offset + 7] << 0;
            startSector |= (cat1[offset + 6] & 3) << 8;

            if (log !== undefined) {
                const name = `${String.fromCharCode(cat0[offset + 7])}.${cat0.toString('binary', offset + 0, offset + 7).trimRight()} `;
                log.pn(`    ${name}: size = 0x${utils.hex8(size)}, start sector = ${startSector} (0x${utils.hex8(startSector)})`);
            }

            for (let i = 0; i < size; i += 256) {
                const sector = startSector + Math.floor(i / SECTOR_SIZE_BYTES);

                usedTracksSet.add(Math.floor(sector / TRACK_SIZE_SECTORS));
            }
        }

        const usedTracks: number[] = [];
        for (const usedTrack of usedTracksSet) {
            usedTracks.push(usedTrack);
        }

        usedTracks.sort();

        //     log?.pn(`Used tracks: ${usedTracks}`);

        return usedTracks;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export function getAddrString(side: number, track: number): string {
    return `T${track.toString().padStart(2, '0')}`;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export function createReadOSWORD(drive: number, track: number, sector: number, numSectors: number): diskimage.IDiskOSWORD {
    const block = Buffer.alloc(11);

    block.writeUInt8(drive, 0);
    block.writeUInt32LE(0xffffffff, 1);//filled in later.
    block.writeUInt8(3, 5);
    block.writeUInt8(0x53, 6);
    block.writeUInt8(track, 7);
    block.writeUInt8(sector, 8);
    block.writeUInt8(1 << 5 | numSectors, 9);

    return {
        reason: 0x7f,
        block,
        data: undefined,
    };
}

// always starts writing at sector 0.
export function createWriteOSWORD(drive: number, track: number, data: Buffer): diskimage.IDiskOSWORD {
    const numSectors = Math.floor(data.length / SECTOR_SIZE_BYTES);
    const block = Buffer.alloc(11);

    block.writeUInt8(drive, 0);
    block.writeUInt32LE(0xffffffff, 1);//filled in later.
    block.writeUInt8(3, 5);
    block.writeUInt8(0x4b, 6);
    block.writeUInt8(track, 7);
    block.writeUInt8(0, 8);
    block.writeUInt8(1 << 5 | numSectors, 9);

    return {
        reason: 0x7f,
        block,
        data,
    };
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export interface ITrackAddress {
    side: number;
    track: number;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export function sortTrackAddresses(tracks: ITrackAddress[]): void {
    tracks.sort((a: ITrackAddress, b: ITrackAddress) => {
        // Write side at a time - this means a re-seek to track 0 partway
        // through writing a dsd, but it avoids horrid noises with DFS 1.20 due
        // to some kind of head unload/reload when switching between heads. (Not
        // an issue on the 1770 DFSs it seems? Might be 8271 specific.) 
        if (a.side < b.side) {
            return -1;
        } else if (a.side > b.side) {
            return 1;
        } else {
            if (a.track < b.track) {
                return -1;
            } else if (a.track > b.track) {
                return 1;
            }
        }

        return 0;
    });
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class WriteFlow extends diskimage.Flow {
    private drive: number;
    private doubleSided: boolean;
    private tracks: ITrackAddress[];
    private partIdx: number;
    private log: utils.Log | undefined;
    private image: Buffer;
    private padSize: number;
    private shownPadMessage: boolean;

    public constructor(drive: number, doubleSided: boolean, allSectors: boolean, image: Buffer, log: utils.Log | undefined) {
        super();

        this.drive = drive;
        this.doubleSided = doubleSided;
        this.partIdx = 0;
        this.log = log;

        this.image = image;

        this.tracks = [];

        if (allSectors) {
            // Since the image size is available, no need to examine its
            // contents. The number of tracks can be inferred from the size.
            let numSides;
            if (this.doubleSided) {
                numSides = 2;
            } else {
                numSides = 1;
            }

            const trackSizeBytes = numSides * TRACK_SIZE_BYTES;
            const numTracks = Math.floor((this.image.length + trackSizeBytes - 1) / trackSizeBytes);
            for (let track = 0; track < numTracks; ++track) {
                for (let side = 0; side < numSides; ++side) {
                    this.tracks.push({ side, track });
                }
            }
        } else {
            if (this.doubleSided) {
                checkSize(image, TRACK_SIZE_BYTES + 512);

                for (const track of getUsedTracks(this.image, 0, false, this.log)) {
                    this.tracks.push({ side: 0, track });
                }

                for (const track of getUsedTracks(this.image, TRACK_SIZE_BYTES, false, this.log)) {
                    this.tracks.push({ side: 1, track });
                }
            } else {
                checkSize(image, 512);

                for (const track of getUsedTracks(this.image, 0, false, this.log)) {
                    this.tracks.push({ side: 0, track });
                }
            }
        }

        if (this.image.length % SECTOR_SIZE_BYTES === 0) {
            this.padSize = 0;
        } else {
            this.padSize = SECTOR_SIZE_BYTES - this.image.length % SECTOR_SIZE_BYTES;
            this.image = Buffer.concat([this.image, Buffer.alloc(this.padSize)]);
        }
        this.shownPadMessage = false;

        sortTrackAddresses(this.tracks);
    }

    public start(bufferAddress: number, bufferSize: number): diskimage.IStartFlow {
        // It's a bit stupid having this check here, but when calling
        // errors.generic from the constructor, the TS compiler moans that
        // fields aren't always being initialized - even though errors.generic
        // never returns.
        //
        // Presumably some JS/TS case that I don't know enough about. Easily
        // avoided.
        for (const track of this.tracks) {
            if (track.track > MAX_NUM_TRACKS) {
                return errors.generic(`Image has more than ${MAX_NUM_TRACKS} tracks`);
            }
        }

        this.init(bufferAddress, bufferSize, 4096);

        return {
            fs: DFS_FS,
            fsStarCommand: ``,
            starCommand: ``,
            osword1: undefined,
            osword2: undefined
        };
    }

    public setCat(p: Buffer): void {
        // ...
    }

    public getNextPart(): diskimage.IPart | undefined {
        if (this.partIdx >= this.tracks.length) {
            return undefined;
        }

        const addr = this.tracks[this.partIdx];

        let imageOffset: number;
        if (this.doubleSided) {
            imageOffset = addr.track * 2 * TRACK_SIZE_BYTES + addr.side * TRACK_SIZE_BYTES;
        } else {
            imageOffset = addr.track * TRACK_SIZE_BYTES;
        }

        const data = Buffer.alloc(TRACK_SIZE_BYTES);
        for (let i = 0; i < TRACK_SIZE_BYTES && imageOffset + i < this.image.length; ++i) {
            data.writeUInt8(this.image.readUInt8(imageOffset + i), i);
        }

        let message = `Write S${addr.side.toString()} ${getAddrString(addr.side, addr.track)} (${((this.partIdx + 1) / this.tracks.length * 100.0).toFixed(1)}%)`;
        if (this.padSize > 0) {
            if (!this.shownPadMessage) {
                message = `(Padded image with ${this.padSize} byte(s))${utils.BNL}`;
                this.shownPadMessage = true;
            }
        }

        return {
            message,
            osword: createWriteOSWORD(this.drive + addr.side * 2, addr.track, data),
        };
    }

    public setLastOSWORDResult(data: Buffer): void {
        ++this.partIdx;
    }

    public async finish(): Promise<diskimage.IFinishFlow> {
        return {
            fs: DFS_FS,
            fsStarCommand: ``,
            starCommand: ``,
        };
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class ReadFlow extends diskimage.Flow {
    private drive: number;
    private doubleSided: boolean;
    private allSectors: boolean;
    private tracks: ITrackAddress[] | undefined;
    private partIdx: number;
    private log: utils.Log | undefined;
    private file: beebfs.File;
    private image: Buffer | undefined;

    public constructor(drive: number, doubleSided: boolean, allSectors: boolean, file: beebfs.File, log: utils.Log | undefined) {
        super();

        this.drive = drive;
        this.doubleSided = doubleSided;
        this.allSectors = allSectors;
        this.partIdx = 0;
        this.log = log;
        this.file = file;
    }

    public start(bufferAddress: number, bufferSize: number): diskimage.IStartFlow {
        this.init(bufferAddress, bufferSize, 4096);

        const osword1 = createReadOSWORD(this.drive, 0, 0, 2);

        let osword2: diskimage.IDiskOSWORD | undefined;
        if (this.doubleSided) {
            osword2 = createReadOSWORD(this.drive | 2, 0, 0, 2);
        }

        return { fs: DFS_FS, fsStarCommand: ``, starCommand: ``, osword1, osword2, };
    }

    public setCat(p: Buffer): void {
        if (this.tracks !== undefined) {
            return errors.generic(`Invalid setCat`);
        }

        this.log?.withIndent('cat: ', () => {
            this.log!.dumpBuffer(p);
        });

        this.tracks = [];

        if (this.doubleSided) {
            if (p.length !== 1024) {
                return errors.generic(`Bad cat size`);
            }

            for (const track of getUsedTracks(p, 0, this.allSectors, this.log)) {
                this.tracks.push({ side: 0, track });
            }

            for (const track of getUsedTracks(p, 512, this.allSectors, this.log)) {
                this.tracks.push({ side: 1, track });
            }
        } else {
            if (p.length !== 512) {
                return errors.generic(`Bad cat size`);
            }

            for (const track of getUsedTracks(p, 0, this.allSectors, this.log)) {
                this.tracks.push({ side: 0, track });
            }
        }

        sortTrackAddresses(this.tracks);

        // find max track.
        let numTracks = 0;
        for (const addr of this.tracks) {
            numTracks = Math.max(numTracks, addr.track + 1);
        }

        if (this.doubleSided) {
            this.image = Buffer.alloc(numTracks * 2 * TRACK_SIZE_BYTES);
        } else {
            this.image = Buffer.alloc(numTracks * TRACK_SIZE_BYTES);
        }

        this.log?.pn(`${this.tracks.length} part(s)`);
    }

    public getNextPart(): diskimage.IPart | undefined {
        if (this.tracks === undefined || this.partIdx >= this.tracks.length) {
            return undefined;
        }

        const addr = this.tracks[this.partIdx];

        return {
            message: `Read S${addr.side.toString()} ${getAddrString(addr.side, addr.track)} (${((this.partIdx + 1) / this.tracks.length * 100.0).toFixed(1)}%)`,
            osword: createReadOSWORD(this.drive + addr.side * 2, addr.track, 0, TRACK_SIZE_SECTORS),
        };
    }

    public setLastOSWORDResult(data: Buffer): void {
        if (this.tracks === undefined || this.partIdx >= this.tracks.length || this.image === undefined) {
            return errors.generic(`Invalid setLastOSWORDResult`);
        }

        if (data.length !== TRACK_SIZE_BYTES) {
            return errors.generic(`Invalid track data (bad size)`);
        }

        const addr = this.tracks[this.partIdx];

        let offset: number;
        if (this.doubleSided) {
            offset = addr.track * 2 * TRACK_SIZE_BYTES + addr.side * TRACK_SIZE_BYTES;
        } else {
            offset = addr.track * TRACK_SIZE_BYTES;
        }

        data.copy(this.image, offset);

        ++this.partIdx;
    }

    public async finish(): Promise<diskimage.IFinishFlow> {
        if (this.tracks === undefined || this.partIdx !== this.tracks.length || this.image === undefined) {
            return errors.generic(`Invalid finish`);
        }

        await beebfs.FS.writeFile(this.file, this.image);

        // Leave BLFS active.
        return {
            fs: 0,
            fsStarCommand: '',
            starCommand: '',
        };
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
