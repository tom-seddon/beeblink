//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2019 Tom Seddon
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
import * as server from './server';
import * as diskimage from './diskimage';
import * as dfsimage from './dfsimage';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////


const TRACK_SIZE_SECTORS = 18;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function getUsedTracks(image: Buffer, trackSizeBytes: number, log: utils.Log | undefined): number[] {
    // DDOS manual says "Number of tracks on the disc - 1", but this doesn't
    // actually appear to be the case...
    const numTracks = image.readUInt8(16 * SECTOR_SIZE_BYTES + 4);

    // if (log !== undefined) {
    //     log.pn(`${numTracks} tracks`);
    // }

    const usedTracks: number[] = [];
    for (let i = 0; i < numTracks; ++i) {
        usedTracks.push(i);
    }

    return usedTracks;
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
            message: `${String.fromCharCode(13)}Reading: S${addr.side.toString()} ${dfsimage.getAddrString(addr.side, addr.track)} (${((this.partIdx + 1) / this.tracks.length * 100.0).toFixed(1)}%)`,
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
