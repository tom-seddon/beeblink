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

interface IUsedTrack {
    index: number;
    sectors: number[];
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

function getUsedTracks(data: Buffer, track0Offset: number, allSectors: boolean, log: utils.Log | undefined): IUsedTrack[] {
    if (data[track0Offset + 0x105] % 8 !== 0) {
        return errors.generic('Bad DFS format (file count)');
    }

    const cat0 = Buffer.from(data.buffer, track0Offset, SECTOR_SIZE_BYTES);
    const cat1 = Buffer.from(data.buffer, track0Offset + SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES);

    if (allSectors) {
        const numSectors = cat1[0x07] | ((cat1[0x06] & 0x03) << 8);

        if (numSectors % TRACK_SIZE_SECTORS !== 0) {
            return errors.generic('Bad DFS format (sector count)');
        }

        const usedTracks: IUsedTrack[] = [];
        for (let index = 0; index < Math.floor(numSectors / TRACK_SIZE_SECTORS); ++index) {
            const sectors: number[] = [];
            for (let i = 0; i < TRACK_SIZE_SECTORS; ++i) {
                sectors.push(i);
            }

            usedTracks.push({ index, sectors });
        }

        return usedTracks;
    } else {
        const usedSectorsByTrack = new Map<number, Set<number>>();

        for (let offset = 8; offset <= cat1[0x05]; offset += 8) {

            let size = 0;
            size |= cat1[offset + 4] << 0;
            size |= cat1[offset + 5] << 8;
            size |= (cat1[offset + 6] >> 4 & 3) << 16;

            let startSector = 0;
            startSector |= cat1[offset + 7] << 0;
            startSector |= (cat1[offset + 6] & 3) << 8;

            if (log !== undefined) {
                const name = `${String.fromCharCode(cat0[offset + 7])}.${cat0.toString('binary', offset + 0, offset + 7).trimRight()}`;
                log.pn(`    ${name}: size=0x${utils.hex8(size)}, start sector=${startSector} (0x${utils.hex8(startSector)})`);
            }

            for (let i = 0; i < size; i += 256) {
                const sector = startSector + Math.floor(i / SECTOR_SIZE_BYTES);

                const track = Math.floor(sector / TRACK_SIZE_SECTORS);

                let usedSectors = usedSectorsByTrack.get(track);
                if (usedSectors === undefined) {
                    usedSectors = new Set<number>();
                    usedSectorsByTrack.set(track, usedSectors);
                }

                usedSectors.add(sector % TRACK_SIZE_SECTORS);
            }
        }

        const usedTracks: IUsedTrack[] = [];
        for (const index of usedSectorsByTrack.keys()) {
            const sectors: number[] = [];
            for (const sector of usedSectorsByTrack.get(index)!) {
                sectors.push(sector);
            }

            sectors.sort();

            usedTracks.push({ index, sectors, });
        }

        usedTracks.sort((a: IUsedTrack, b: IUsedTrack) => {
            if (a.index < b.index) {
                return -1;
            } else if (a.index > b.index) {
                return 1;
            } else {
                return 0;
            }
        });

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
    for (const usedTrack of usedTracks) {
        // If the image finishes early, just assume it's a truncated image.

        const begin = diskImageTrack0Offset + usedTrack.index * diskImageTrackSizeBytes;
        const end = begin + TRACK_SIZE_BYTES;

        const data = Buffer.alloc(TRACK_SIZE_BYTES, 0);

        let destIdx = 0;
        let srcIdx = 0;
        while (srcIdx < end && srcIdx < diskImageData.length) {
            data[destIdx++] = diskImageData[srcIdx++];
        }

        tracks.push({
            drive,
            index: usedTrack.index,
            data,
        });
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
