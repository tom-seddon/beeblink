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

import * as assert from 'assert';
import * as utils from './utils';
import * as beebfs from './beebfs';
import { MAX_DISK_IMAGE_PART_SIZE } from './beeblink';
import * as errors from './errors';

const TRACK_SIZE_SECTORS = 16;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;

const S_SIZE_BYTES = 1 * 40 * TRACK_SIZE_BYTES;
const M_SIZE_BYTES = 1 * 80 * TRACK_SIZE_BYTES;
const L_SIZE_BYTES = 2 * 80 * TRACK_SIZE_BYTES;

function checkChecksum(sector: Buffer, index: number): void {
    let sum = 255;

    for (let i = 254; i >= 0; --i) {
        //console.log('i=' + utils.hex2(i) + ', sum=' + utils.hex2(sum) + ', sector[' + i + ']=' + utils.hex2(sector[i]));
        if (sum > 255) {
            sum = (sum + 1) & 0xff;
        }
        sum += sector[i];
        //console.log('sum now=' + utils.hex2(sum));
    }

    if ((sum & 0xff) !== sector[0xff]) {
        return errors.generic('Bad ADFS image (bad map) (' + index + ' ' + utils.hex2(sum) + ' ' + utils.hex2(sector[0xff]) + ')');
    }
}

export interface IADFSImage {
    totalNumSectors: number;
    parts: Buffer[];
}

interface IPart {
    sector: number;
    data: Buffer;
}

export function getADFSImage(data: Buffer, drive: number, allSectors: boolean, log: utils.Log): IADFSImage {
    log.pn('getADFSImage: data=' + data.length + ' byte(s)');
    // Check image size. Rearrange ADFS L images so they're in ADFS logical
    // sector order.
    switch (data.length) {
        case S_SIZE_BYTES:
        case M_SIZE_BYTES:
            // good as-is.
            break;

        case L_SIZE_BYTES:
            const tmp = Buffer.alloc(L_SIZE_BYTES);
            for (let i = 0; i < L_SIZE_BYTES; ++i) {
                tmp[i] = data[i];
            }

            let destIdx = 0;
            for (let side = 0; side < 2; ++side) {
                for (let track = 0; track < 80; ++track) {
                    let srcIdx = (track * 2 + side) * TRACK_SIZE_BYTES;
                    for (let sector = 0; sector < TRACK_SIZE_SECTORS; ++sector) {
                        for (let i = 0; i < SECTOR_SIZE_BYTES; ++i) {
                            data[destIdx++] = tmp[srcIdx++];
                        }
                    }
                }
            }
            break;

        default:
            return errors.generic('Bad ADFS image (unsupported size)');
    }

    // Check ADFS format.
    log.pn('Check ADFS format');
    if (data.toString('binary', 0x201, 0x205) !== 'Hugo') {
        return errors.generic('Bad ADFS image (no Hugo)');
    }

    const sector0 = Buffer.from(data.buffer, 0, 256);
    const sector1 = Buffer.from(data.buffer, 256, 256);

    checkChecksum(sector0, 0);
    checkChecksum(sector1, 1);

    if (sector1[0xfe] % 3 !== 0) {
        return errors.generic('Bad ADFS image (bad free space list size)');
    }

    const totalNumSectors = utils.getUInt24LE(sector0, 0xfc);
    if (totalNumSectors * SECTOR_SIZE_BYTES !== data.length) {
        return errors.generic('Bad ADFS image (bad sector count)');
    }

    if (totalNumSectors >= (1 << 21)) {
        return errors.generic('Bad ADFS image (sector count too large)');
    }

    // Get list of used sectors.
    const isSectorUsed: boolean[] = [];
    for (let i = 0; i < totalNumSectors; ++i) {
        isSectorUsed.push(true);
    }

    if (allSectors) {
        log.pn(`Assuming all sectors used`);
    } else {
        log.pn('Find unused sectors');

        for (let i = 0; i < sector1[0xfe]; i += 3) {
            const startSector = utils.getUInt24LE(sector0, i);
            const numSectors = utils.getUInt24LE(sector1, i);

            for (let j = 0; j < numSectors; ++j) {
                const sector = startSector + j;
                if (sector >= totalNumSectors) {
                    return errors.generic('Bad ADFS image (invalid free space map)');
                }

                if (!isSectorUsed[sector]) {
                    return errors.generic('Bad ADFS image (free space overlap)');
                }

                isSectorUsed[sector] = false;
            }
        }
    }

    {
        let numUsedSectors = 0;
        for (const used of isSectorUsed) {
            if (used) {
                ++numUsedSectors;
            }
        }
        log.pn(`${numUsedSectors}/${totalNumSectors} sector(s) used`);
    }

    // Group used sectors into parts that don't exceed the max part size.
    log.pn('Collect used sectors');
    const maxPartSizeBytes = Math.floor((MAX_DISK_IMAGE_PART_SIZE & 0xff00) / SECTOR_SIZE_BYTES) * SECTOR_SIZE_BYTES;
    log.pn('(max part size: ' + maxPartSizeBytes + ')');
    const parts: IPart[] = [];
    {
        let part: IPart | undefined;

        for (let sector = 0; sector < totalNumSectors; ++sector) {
            if (isSectorUsed[sector]) {
                if (part === undefined) {
                    part = { sector, data: Buffer.alloc(0) };
                    parts.push(part);
                }

                part.data = Buffer.concat([part.data, Buffer.from(data.buffer, sector * SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES)]);

                if (part.data.length === maxPartSizeBytes) {
                    part = undefined;
                }
            } else {
                part = undefined;
            }
        }
    }

    log.pn(parts.length + ' parts');

    // Add an OSWORD $72 parameter block and a message to each part.
    const parts2: Buffer[] = [];//nope... not sure about the naming here.

    for (let partIdx = 0; partIdx < parts.length; ++partIdx) {
        const part = parts[partIdx];

        const messageString = String.fromCharCode(13) + 'Writing: ' + (((partIdx + 1) / parts.length) * 100.0).toFixed(1) + '%' + String.fromCharCode(0);
        const messageData = Buffer.from(messageString, 'binary');

        const part2 = Buffer.concat([Buffer.alloc(16), messageData, part.data]);

        part2.writeInt32LE(16 + messageData.length, 1);//data pointer
        part2.writeUInt8(0x0a, 5);//0x0a=write

        // disk address is big-endian.
        part2.writeUInt8(part.sector >> 16 & 31, 6);//drive/sector number
        part2.writeUInt16BE(part.sector & 0xffff, 7);//sector number

        part2.writeUInt32LE(part.data.length, 11);

        parts2.push(part2);
    }

    return { totalNumSectors, parts: parts2 };
}
