//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2018 Tom Seddon
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

const TRACK_SIZE_SECTORS = 10;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;

function checkSize(data: Buffer, minSize: number): void {
    if (data.length % SECTOR_SIZE_BYTES !== 0) {
        return errors.generic('Bad image size (not sector aligned)');
    }

    if (data.length < minSize) {
        throw Error('Bad image size (must be >=' + minSize + ')');
    }
}

interface ITrack {
    drive: number;
    index: number;
    data: Buffer;
}

function compareTracks(a: ITrack, b: ITrack): number {
    // Sort by track first, to minimize seeks.

    if (a.index < b.index) {
        return -1;
    } else if (a.index > b.index) {
        return 1;
    }

    if (a.drive < b.drive) {
        return -1;
    } else if (a.drive > b.drive) {
        return 1;
    }

    return 0;
}

function getNumSectors(data: Buffer, cat1Offset: number): number {
    return data[cat1Offset + 0x07] | ((data[cat1Offset + 0x06] & 0x03) << 8);
}

function getUsedTracks(data: Buffer, track0Offset: number, allSectors: boolean, log: utils.Log | undefined): number[] {
    if (data[track0Offset + 0x105] % 8 !== 0) {
        return errors.generic('Bad DFS format (file count)');
    }

    const cat0 = Buffer.from(data.buffer, track0Offset, SECTOR_SIZE_BYTES);
    const cat1 = Buffer.from(data.buffer, track0Offset + SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES);

    if (allSectors) {
        const numSectors = getNumSectors(cat1, 0);

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

        // if (log !== undefined) {
        //     log.pn(`Used tracks: ${usedTracks}`);
        // }

        return usedTracks;
    }
}

function getSideTracks(diskImageData: Buffer, drive: number, diskImageTrack0Offset: number, diskImageTrackSizeBytes: number, allSectors: boolean, log: utils.Log): ITrack[] {
    if (diskImageData[diskImageTrack0Offset + 0x105] % 8 !== 0) {
        return errors.generic('Bad DFS format (file count)');
    }

    log.pn('Files on drive ' + drive + ':');
    const usedTracks = getUsedTracks(diskImageData, diskImageTrack0Offset, allSectors, log);

    const tracks: ITrack[] = [];
    for (const index of usedTracks) {
        // If the image finishes early, just assume it's a truncated image.

        const begin = diskImageTrack0Offset + index * diskImageTrackSizeBytes;
        const end = begin + TRACK_SIZE_BYTES;

        const data = Buffer.alloc(TRACK_SIZE_BYTES, 0);

        let destIdx = 0;
        let srcIdx = begin;
        while (srcIdx < end && srcIdx < diskImageData.length) {
            data[destIdx++] = diskImageData[srcIdx++];
        }

        tracks.push({ drive, index, data, });
    }

    return tracks;
}

function getPartBuffers(tracks: ITrack[]): Buffer[] {
    const buffers: Buffer[] = [];

    tracks.sort(compareTracks);

    for (let i = 0; i < tracks.length; ++i) {
        const messageString = String.fromCharCode(13) + 'Writing: ' + (((i + 1) / tracks.length) * 100.0).toFixed(1) + '%' + String.fromCharCode(0);
        const messageData = Buffer.from(messageString, 'binary');

        const data = Buffer.concat([
            Buffer.alloc(16),
            messageData,
            tracks[i].data,
        ]);

        data.writeUInt8(tracks[i].drive, 0);//drive number
        data.writeUInt32LE(16 + messageData.length, 1);//data offset
        data.writeUInt8(3, 5);//parameter count
        data.writeUInt8(0x4b, 6);//write
        data.writeUInt8(tracks[i].index, 7);//track number
        data.writeUInt8(0, 8);//sector number
        data.writeUInt8(1 << 5 | TRACK_SIZE_SECTORS, 9);//sector size (1=256 bytes)/count
        data.writeUInt8(0, 10);//space for result

        buffers.push(data);
    }

    return buffers;
}

export function getSSDParts(diskImageData: Buffer, drive: number, allSectors: boolean, log: utils.Log): Buffer[] {
    checkSize(diskImageData, 2 * SECTOR_SIZE_BYTES);

    const tracks = getSideTracks(diskImageData, drive, 0, TRACK_SIZE_BYTES, allSectors, log);

    return getPartBuffers(tracks);
}

export function getDSDParts(diskImageData: Buffer, drive: number, allSectors: boolean, log: utils.Log): Buffer[] {
    checkSize(diskImageData, TRACK_SIZE_BYTES + 2 * SECTOR_SIZE_BYTES);

    let tracks = getSideTracks(diskImageData, drive, 0, 2 * TRACK_SIZE_BYTES, allSectors, log);
    tracks = tracks.concat(getSideTracks(diskImageData, drive | 2, TRACK_SIZE_BYTES, 2 * TRACK_SIZE_BYTES, allSectors, log));

    return getPartBuffers(tracks);
}

interface IReadTrack {
    side: number;
    track: number;
}

interface IReadPart {
    side: number;
    track: number;
    oswordBuffer: Buffer;
    dataBuffer: Buffer | undefined;
}

export class Reader implements server.IDiskImageReader {
    private drive: number;
    private doubleSided: boolean;
    private allSectors: boolean;
    private parts: IReadPart[] | undefined;
    private partIdx: number;
    private log: utils.Log | undefined;
    private oshwm: number | undefined;

    public constructor(drive: number, doubleSided: boolean, allSectors: boolean, log: utils.Log | undefined) {
        this.drive = drive;
        this.doubleSided = doubleSided;
        this.allSectors = allSectors;
        this.partIdx = 0;
        this.log = log;
    }

    public start(oshwm: number, himem: number): Buffer {
        const b = new utils.BufferBuilder();

        b.writeUInt8(4);//4=DFS

        // first OSWORD info
        b.writeUInt8(0x7f);
        const osword0AddrOffset = b.writeUInt16LE(0);//filled in later
        const osword0ResultOffsetOffset = b.writeUInt8(0);//filled in later

        // second OSWORD info
        b.writeUInt8(this.doubleSided ? 0x7f : 0x00);
        const osword1AddrOffset = b.writeUInt16LE(0);
        const osword1ResultOffsetOffset = b.writeUInt8(0);

        const payloadAddrOffset = b.writeUInt32LE(0);
        b.writeUInt32LE(this.doubleSided ? 1024 : 512);

        // first OSWORD block
        b.setUInt16LE(oshwm + b.getLength(), osword0AddrOffset);
        b.setUInt8(b.getLength() + 10, osword0ResultOffsetOffset);
        const osword0BlockOffset = this.addOSWORD7f(b, this.drive, 0, 0, 2);

        let osword1BlockOffset: number | undefined;
        if (this.doubleSided) {
            // second OSWORD block
            b.setUInt16LE(oshwm + b.getLength(), osword1AddrOffset);
            b.setUInt8(b.getLength() + 10, osword1ResultOffsetOffset);
            osword1BlockOffset = this.addOSWORD7f(b, this.drive | 2, 0, 0, 2);
        }

        const payloadAddr = 0xffff0000 | (oshwm + b.getLength());
        b.setUInt32LE(payloadAddr, osword0BlockOffset + 1);
        b.setUInt32LE(payloadAddr, payloadAddrOffset);

        if (this.doubleSided) {
            b.setUInt32LE(payloadAddr + 512, osword1BlockOffset! + 1);
        }

        this.oshwm = oshwm;

        return b.createBuffer();
    }

    public setCat(p: Buffer): void {
        if (this.parts !== undefined) {
            return errors.generic(`Invalid setCat`);
        }

        const tracks: IReadTrack[] = [];

        if (this.doubleSided) {
            if (p.length !== 1024) {
                return errors.generic(`Bad cat size`);
            }

            for (const track of getUsedTracks(p, 0, this.allSectors, this.log)) {
                tracks.push({ side: 0, track });
            }

            for (const track of getUsedTracks(p, 512, this.allSectors, this.log)) {
                tracks.push({ side: 1, track });
            }
        } else {
            if (p.length !== 512) {
                return errors.generic(`Bad cat size`);
            }

            for (const track of getUsedTracks(p, 0, this.allSectors, this.log)) {
                tracks.push({ side: 0, track });
            }
        }

        tracks.sort((a: IReadTrack, b: IReadTrack) => {
            if (a.track < b.track) {
                return -1;
            } else if (a.track > b.track) {
                return 1;
            } else {
                if (a.side < b.side) {
                    return -1;
                } else if (a.side > b.side) {
                    return 1;
                }
            }

            return 0;
        });

        this.parts = [];
        for (let i = 0; i < tracks.length; ++i) {
            this.addReadPart(tracks[i].side, tracks[i].track, (i + 1) / tracks.length);
        }

        if (this.log !== undefined) {
            this.log.pn(`${this.parts.length} part(s)`);
        }
    }

    public getNextOSWORD(): Buffer | undefined {
        if (this.parts === undefined || this.partIdx >= this.parts.length) {
            return undefined;
        }

        return this.parts[this.partIdx].oswordBuffer;
    }

    public setPart(data: Buffer): void {
        if (this.parts === undefined || this.partIdx >= this.parts.length) {
            return errors.generic(`Invalid setLastReadPart`);
        }

        this.parts[this.partIdx++].dataBuffer = data;
    }

    public getImage(): Buffer {
        return Buffer.alloc(0);
    }

    private addOSWORD7f(b: utils.BufferBuilder, drive: number, track: number, sector: number, numSectors: number): number {
        const offset = b.writeUInt8(this.drive);

        b.writeUInt32LE(0);//fixed up later

        b.writeUInt8(3);
        b.writeUInt8(0x53);
        b.writeUInt8(track);
        b.writeUInt8(sector);
        b.writeUInt8(1 << 5 | numSectors);
        b.writeUInt8(0);

        return offset;
    }

    private addReadPart(side: number, track: number, frac: number): void {
        if (this.parts === undefined || this.oshwm === undefined) {
            return errors.generic(`Invalid addReadPart`);
        }

        const b = new utils.BufferBuilder();

        b.writeUInt8(0x7f);
        const oswordBlockAddrOffset = b.writeUInt16LE(0);
        const oswordResultOffsetOffset = b.writeUInt8(0);
        const messageAddrOffset = b.writeUInt16LE(0);
        const payloadAddrOffset = b.writeUInt32LE(0);
        b.writeUInt32LE(TRACK_SIZE_BYTES);

        const oswordBlockOffset = this.addOSWORD7f(b, this.drive + side * 2, track, 0, TRACK_SIZE_SECTORS);
        b.setUInt16LE(this.oshwm + oswordBlockOffset, oswordBlockAddrOffset);
        b.setUInt8(oswordBlockOffset + 10, oswordResultOffsetOffset);

        b.setUInt16LE(this.oshwm + b.getLength(), messageAddrOffset);
        b.writeString(`${String.fromCharCode(13)}Reading: ${(frac * 100.0).toFixed(1)}%${String.fromCharCode(255)}`);

        const payloadAddr = 0xffff0000 | (this.oshwm + b.getLength());
        b.setUInt32LE(payloadAddr, oswordBlockOffset + 1);
        b.setUInt32LE(payloadAddr, payloadAddrOffset);

        this.parts.push({
            side,
            track,
            oswordBuffer: b.createBuffer(),
            dataBuffer: undefined,
        });
    }
}
