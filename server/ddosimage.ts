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
import * as dfsimage from './dfsimage';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const TRACK_SIZE_SECTORS = 18;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function getNumTracks(image: Buffer, track0Offset: number): number {
    // DDOS manual says "Number of tracks on the disc - 1", but this doesn't
    // actually appear to be the case...
    return image.readUInt8(track0Offset + 16 * SECTOR_SIZE_BYTES + 4);
}

// Maybe one day I'll fill this in properly... 
function getUsedTracks(image: Buffer, track0Offset: number, log: utils.Log | undefined): number[] {
    const numTracks = getNumTracks(image, track0Offset);
    //     log?.pn(`${numTracks} tracks`);

    const usedTracks: number[] = [];
    for (let i = 0; i < numTracks; ++i) {
        usedTracks.push(i);
    }

    return usedTracks;
}

function getMessage(addr: dfsimage.ITrackAddress, partIdx: number, numParts: number): string {
    return `S${addr.side.toString()} ${dfsimage.getAddrString(addr.side, addr.track)} (${((partIdx + 1) / numParts * 100.0).toFixed(1)}%)`;
}

function getOffset(addr: dfsimage.ITrackAddress, doubleSided: boolean): number {
    if (doubleSided) {
        return (addr.track * 2 + addr.side) * TRACK_SIZE_BYTES;
    } else {
        return addr.track * TRACK_SIZE_BYTES;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class ReadFlow extends diskimage.Flow {
    private drive: number;
    private doubleSided: boolean;
    private tracks: dfsimage.ITrackAddress[] | undefined;
    private partIdx: number;
    private log: utils.Log | undefined;
    private file: beebfs.File;
    private image: Buffer | undefined;

    public constructor(drive: number, doubleSided: boolean, file: beebfs.File, log: utils.Log | undefined) {
        super();

        this.drive = drive;
        this.doubleSided = doubleSided;
        this.partIdx = 0;
        this.log = log;
        this.file = file;
    }

    public start(bufferAddress: number, bufferSize: number): diskimage.IStartFlow {
        this.init(bufferAddress, bufferSize, 256 + 2 * TRACK_SIZE_BYTES);

        const osword1 = dfsimage.createReadOSWORD(this.drive, 0, 0, TRACK_SIZE_SECTORS);

        let osword2: diskimage.IDiskOSWORD | undefined;
        if (this.doubleSided) {
            osword2 = dfsimage.createReadOSWORD(this.drive | 2, 0, 0, TRACK_SIZE_SECTORS);
        }

        return { fs: dfsimage.DFS_FS, fsStarCommand: ``, starCommand: ``, osword1, osword2, };
    }

    public setCat(p: Buffer): void {
        if (this.tracks !== undefined) {
            return errors.generic(`Invalid setCat`);
        }

        this.tracks = [];

        for (const track of getUsedTracks(p, 0, this.log)) {
            this.tracks.push({ side: 0, track });
        }

        if (this.doubleSided) {
            for (const track of getUsedTracks(p, TRACK_SIZE_BYTES, this.log)) {
                this.tracks.push({ side: 1, track });
            }
        }

        dfsimage.sortTrackAddresses(this.tracks);

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
    }

    public getNextPart(): diskimage.IPart | undefined {
        if (this.tracks === undefined || this.partIdx >= this.tracks.length) {
            return undefined;
        }

        const addr = this.tracks[this.partIdx];

        return {
            message: `Read ${getMessage(addr, this.partIdx, this.tracks.length)}`,
            osword: dfsimage.createReadOSWORD(this.drive + addr.side * 2, addr.track, 0, TRACK_SIZE_SECTORS),
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

        data.copy(this.image, getOffset(addr, this.doubleSided));

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

export class WriteFlow extends diskimage.Flow {
    private drive: number;
    private doubleSided: boolean;
    private log: utils.Log | undefined;
    private image: Buffer;
    private tracks: dfsimage.ITrackAddress[];
    private partIdx: number;

    public constructor(drive: number, doubleSided: boolean, image: Buffer, log: utils.Log | undefined) {
        super();

        this.drive = drive;
        this.doubleSided = doubleSided;
        this.log = log;
        this.image = image;

        this.tracks = [];
        for (const track of getUsedTracks(this.image, 0, this.log)) {
            this.tracks.push({ side: 0, track });
        }

        if (this.doubleSided) {
            for (const track of getUsedTracks(this.image, TRACK_SIZE_BYTES, this.log)) {
                this.tracks.push({ side: 1, track });
            }
        }

        dfsimage.sortTrackAddresses(this.tracks);

        this.partIdx = 0;
    }

    public start(oshwm: number, himem: number): diskimage.IStartFlow {
        this.init(oshwm, himem, 256 + 2 * TRACK_SIZE_BYTES);

        const osword1 = dfsimage.createReadOSWORD(this.drive, 0, 0, TRACK_SIZE_SECTORS);

        let osword2: diskimage.IDiskOSWORD | undefined;
        if (this.doubleSided) {
            osword2 = dfsimage.createReadOSWORD(this.drive | 2, 0, 0, TRACK_SIZE_SECTORS);
        }

        return { fs: dfsimage.DFS_FS, fsStarCommand: ``, starCommand: ``, osword1, osword2, };
    }

    public setCat(p: Buffer): void {
        const numDiskTracks0 = getNumTracks(p, 0);
        const numImageTracks0 = getNumTracks(this.image, 0);
        if (numDiskTracks0 !== numImageTracks0) {
            return errors.generic(`Disk / image format mismatch`);
        }

        if (this.doubleSided) {
            const numDiskTracks1 = getNumTracks(p, TRACK_SIZE_BYTES);
            const numImageTracks1 = getNumTracks(this.image, TRACK_SIZE_BYTES);
            if (numDiskTracks1 !== numImageTracks1) {
                return errors.generic(`Disk / image format mismatch`);
            }
        }
    }

    public getNextPart(): diskimage.IPart | undefined {
        if (this.partIdx >= this.tracks.length) {
            return undefined;
        }

        const addr = this.tracks[this.partIdx];

        const data = Buffer.alloc(TRACK_SIZE_BYTES);

        const offset = getOffset(addr, this.doubleSided);
        this.image.copy(data, 0, offset, offset + TRACK_SIZE_BYTES);

        return {
            message: `Write ${getMessage(addr, this.partIdx, this.tracks.length)}`,
            osword: dfsimage.createWriteOSWORD(this.drive + addr.side * 2, addr.track, data),
        };
    }

    public setLastOSWORDResult(data: Buffer): void {
        ++this.partIdx;
    }

    public async finish(): Promise<diskimage.IFinishFlow> {
        return {
            fs: dfsimage.DFS_FS,
            fsStarCommand: ``,
            starCommand: ``,
        };
    }
}
