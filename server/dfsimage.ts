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

const TRACK_SIZE_SECTORS = 10;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;

function throwError(message: string): never {
    throw new beebfs.BeebError(beebfs.ErrorCode.DiscFault, message);
}

function checkSize(data: Buffer, minSize: number): void {
    if (data.length % SECTOR_SIZE_BYTES !== 0) {
        throwError('Bad image size (not sector aligned)');
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

function getSideTracks(diskImageData: Buffer, drive: number, diskImageTrack0Offset: number, diskImageTrackSizeBytes: number, log: utils.Log): ITrack[] {
    if (diskImageData[diskImageTrack0Offset + 0x105] % 8 !== 0) {
        throwError('Bad DFS format (file count)');
    }

    const tracksUsedMap = new Map<number, boolean>();

    log.pn('Files on drive ' + drive + ':');

    const cat0 = Buffer.from(diskImageData.buffer, diskImageTrack0Offset, SECTOR_SIZE_BYTES);
    const cat1 = Buffer.from(diskImageData.buffer, diskImageTrack0Offset + SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES);

    for (let offset = 8; offset <= diskImageData[diskImageTrack0Offset + 0x105]; offset += 8) {
        let name = ':' + drive + '.';
        name += String.fromCharCode(cat0[offset + 7]);
        name += '.';
        name += cat0.toString('binary', offset + 0, offset + 7).trimRight();

        let size = 0;
        size |= cat1[offset + 4] << 0;
        size |= cat1[offset + 5] << 8;
        size |= (cat1[offset + 6] >> 4 & 3) << 16;

        let startSector = 0;
        startSector |= cat1[offset + 7] << 0;
        startSector |= (cat1[offset + 6] & 3) << 8;

        log.pn('    ' + name + ': size=0x' + utils.hex8(size) + ', start sector=' + startSector + ' (0x' + utils.hex8(startSector) + ')');

        for (let i = 0; i < size; i += 256) {
            const sector = startSector + Math.floor(i / SECTOR_SIZE_BYTES);
            tracksUsedMap.set(Math.floor(sector / TRACK_SIZE_SECTORS), true);
        }
    }

    const tracks: ITrack[] = [];
    for (const trackIndex of tracksUsedMap.keys()) {
        const headerSize = 16;//needs to be >=11
        const data = Buffer.alloc(headerSize + TRACK_SIZE_BYTES);

        data.writeUInt8(drive, 0);//drive number
        data.writeUInt32LE(headerSize, 1);//data offset
        data.writeUInt8(3, 5);//parameter count
        data.writeUInt8(0x4b, 6);//write
        data.writeUInt8(trackIndex, 7);//track number
        data.writeUInt8(0, 8);//sector number
        data.writeUInt8(1 << 5 | TRACK_SIZE_SECTORS, 9);//sector size (1=256 bytes)/count
        data.writeUInt8(0, 10);//space for result

        let srcIdx = diskImageTrack0Offset + trackIndex * diskImageTrackSizeBytes;

        for (let i = 0; i < TRACK_SIZE_BYTES; ++i) {
            if (srcIdx < diskImageData.length) {
                data[headerSize + i] = diskImageData[srcIdx];
            }
            ++srcIdx;
        }

        tracks.push({ drive, index: trackIndex, data });
    }

    tracks.sort(compareTracks);

    log.p('Tracks used:');
    for (const track of tracks) {
        log.p(' ' + track.index);
    }
    log.pn('');

    return tracks;
}

function getPartBuffers(tracks: ITrack[]): Buffer[] {
    const buffers: Buffer[] = [];

    tracks.sort(compareTracks);

    for (const track of tracks) {
        buffers.push(track.data);
    }

    return buffers;
}

export function getSSDParts(diskImageData: Buffer, drive: number, log: utils.Log): Buffer[] {
    checkSize(diskImageData, 2 * SECTOR_SIZE_BYTES);

    const tracks = getSideTracks(diskImageData, drive, 0, TRACK_SIZE_BYTES, log);

    return getPartBuffers(tracks);
}

export function getDSDParts(diskImageData: Buffer, drive: number, log: utils.Log): Buffer[] {
    checkSize(diskImageData, TRACK_SIZE_BYTES + 2 * SECTOR_SIZE_BYTES);

    let tracks = getSideTracks(diskImageData, drive, 0, 2 * TRACK_SIZE_BYTES, log);
    tracks = tracks.concat(getSideTracks(diskImageData, drive | 2, TRACK_SIZE_BYTES, 2 * TRACK_SIZE_BYTES, log));

    return getPartBuffers(tracks);
}
