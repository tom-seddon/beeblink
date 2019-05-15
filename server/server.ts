//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
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
import * as beeblink from './beeblink';
import * as beebfs from './beebfs';
import * as path from 'path';
import * as volumebrowser from './volumebrowser';
import * as speedtest from './speedtest';
import * as dfsimage from './dfsimage';
import * as adfsimage from './adfsimage';
import * as crypto from 'crypto';
import { BNL } from './utils';
import { Chalk } from 'chalk';
import Request from './Request';
import Response from './Response';
import * as errors from './errors';
import CommandLine from './CommandLine';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function newResponse(c: number, p?: number | Buffer | utils.BufferBuilder) {
    let data: Buffer;
    if (typeof (p) === 'number') {
        data = Buffer.alloc(1);
        data[0] = p;
    } else if (p instanceof Buffer) {
        data = p;
    } else if (p instanceof utils.BufferBuilder) {
        data = p.createBuffer();
    } else {
        data = Buffer.alloc(0);
    }

    return new Response(c, data);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Command {
    public readonly nameUC: string;
    public readonly syntax: string | undefined;

    public readonly fun: (commandLine: CommandLine) => Promise<Response>;// if this signature changes, change Server.handleStarCommand too.

    public constructor(name: string, syntax: string | undefined, fun: (commandLine: CommandLine) => Promise<Response>) {
        this.nameUC = name.toUpperCase();
        this.syntax = syntax;
        this.fun = fun;
    }

    public async applyFun(thisObject: any, commandLine: CommandLine): Promise<Response> {
        return await this.fun.apply(thisObject, [commandLine]);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Handler {
    public readonly name: string;
    public readonly fun: (handler: Handler, p: Buffer) => Promise<Response>;
    private quiet: boolean;

    public constructor(name: string, fun: (handler: Handler, p: Buffer) => Promise<Response>) {
        this.name = name;
        this.fun = fun;
        this.quiet = false;
    }

    // JS crap that's seemingly impossible to deal with in any non-annoying way.
    public async applyFun(thisObject: any, p: Buffer): Promise<Response> {
        return await this.fun.apply(thisObject, [this, p]);
    }

    public shouldLog(): boolean {
        return !this.quiet;
    }

    public withNoLogging(): Handler {
        this.quiet = true;
        return this;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// This handles the front-end duties of decomposing payloads, parsing command
// lines, routing requests to the appropriate methods of BeebFS, and dealing
// with the packet writing. The plan is that the BeebFS part could be
// replaceable (e.g., providing something more like ADFS), while leaving the
// command syntax mostly intact, but that's so far only a theory.
//
// There are various special cases and bits of odd behaviour that presumably
// just arise naturally from whatever the DFS does internally. I just left them
// as special cases, and didn't sweat the details too much - it's supposed to
// accept whatever the DFS would accept, and reject whatever it would reject,
// and if you get (say) a 'Bad drive' rather than 'Syntax: xxx', then that's
// fine.

export default class Server {
    private bfs: beebfs.BeebFS;
    // romPath is set directly from the command line options struct, which is
    // why it's a bit inconistent.
    private romPath: string | null;
    private stringBuffer: Buffer | undefined;
    private stringBufferIdx: number;
    private commands: Command[];
    private handlers: (Handler | undefined)[];
    private log: utils.Log;
    private volumeBrowser: volumebrowser.Browser | undefined;
    private speedTest: speedtest.SpeedTest | undefined;
    private dumpPackets: boolean;
    private imageParts: Buffer[] | undefined;
    private imagePartIdx: number;

    public constructor(romPath: string | null, bfs: beebfs.BeebFS, logPrefix: string | undefined, colours: Chalk | undefined, dumpPackets: boolean) {
        this.romPath = romPath;
        this.bfs = bfs;
        this.stringBufferIdx = 0;
        this.imagePartIdx = 0;

        this.commands = [
            new Command('ACCESS', '<afsp> (<mode>)', this.accessCommand),
            new Command('DELETE', '<fsp>', this.deleteCommand),
            new Command('DIR', '(<dir>)', this.dirCommand),
            new Command('DRIVE', '(<drive>)', this.driveCommand),
            new Command('DRIVES', '', this.drivesCommand),
            new Command('DUMP', '<fsp>', this.dumpCommand),
            new Command('FILES', undefined, this.filesCommand),
            new Command('INFO', '<afsp>', this.infoCommand),
            new Command('LIB', '(<dir>)', this.libCommand),
            new Command('LIST', '<fsp>', this.listCommand),
            new Command('LOCATE', '<afsp>', this.locateCommand),
            new Command('NEWVOL', '<vsp>', this.newvolCommand),
            new Command('RENAME', '<old fsp> <new fsp>', this.renameCommand),
            new Command('SELFUPDATE', undefined, this.selfupdateCommand),
            new Command('SRLOAD', '<fsp> <addr> <bank> (Q)', this.srloadCommand),
            new Command('SPEEDTEST', undefined, this.speedtestCommand),
            new Command('TITLE', '<title>', this.titleCommand),
            new Command('TYPE', '<fsp>', this.typeCommand),
            new Command('VOLBROWSER', undefined, this.volbrowserCommand),
            new Command('VOL', '(<avsp>) (R)', this.volCommand),
            new Command('VOLS', '(<avsp>)', this.volsCommand),
            new Command('WDUMP', '<fsp>', this.wdumpCommand),
            new Command('WRITE', '<fsp> <drive> <type>', this.writeCommand),
        ];

        this.handlers = [];
        this.handlers[beeblink.REQUEST_GET_ROM] = new Handler('GET_ROM', this.handleGetROM);
        this.handlers[beeblink.REQUEST_RESET] = new Handler('RESET', this.handleReset);
        this.handlers[beeblink.REQUEST_ECHO_DATA] = new Handler('ECHO_DATA', this.handleEchoData);
        this.handlers[beeblink.REQUEST_READ_STRING] = new Handler('READ_STRING', this.handleReadString).withNoLogging();
        this.handlers[beeblink.REQUEST_READ_STRING_VERBOSE] = new Handler('READ_STRING_VERBOSE', this.handleReadString);
        this.handlers[beeblink.REQUEST_STAR_CAT] = new Handler('STAR_CAT', this.handleStarCat);
        this.handlers[beeblink.REQUEST_STAR_COMMAND] = new Handler('STAR_COMMAND', this.handleStarCommand);
        this.handlers[beeblink.REQUEST_STAR_RUN] = new Handler('STAR_RUN', this.handleStarRun);
        this.handlers[beeblink.REQUEST_HELP_BLFS] = new Handler('HELP_BLFS', this.handleHelpBLFS);
        this.handlers[beeblink.REQUEST_OSFILE] = new Handler('OSFILE', this.handleOSFILE);
        this.handlers[beeblink.REQUEST_OSFIND_OPEN] = new Handler('OSFIND_OPEN', this.handleOSFINDOpen);
        this.handlers[beeblink.REQUEST_OSFIND_CLOSE] = new Handler('OSFIND_CLOSE', this.handleOSFINDClose);
        this.handlers[beeblink.REQUEST_OSARGS] = new Handler('OSARGS', this.handleOSARGS);
        this.handlers[beeblink.REQUEST_EOF] = new Handler('EOF', this.handleEOF);
        this.handlers[beeblink.REQUEST_OSBGET] = new Handler('OSBGET', this.handleOSBGET);//.withNoLogging();
        this.handlers[beeblink.REQUEST_OSBPUT] = new Handler('OSBPUT', this.handleOSBPUT);//.withNoLogging();
        this.handlers[beeblink.REQUEST_STAR_INFO] = new Handler('STAR_INFO', this.handleStarInfo);
        this.handlers[beeblink.REQUEST_STAR_EX] = new Handler('STAR_EX', this.handleStarEx);
        this.handlers[beeblink.REQUEST_OSGBPB] = new Handler('OSGBPB', this.handleOSGBPB);
        this.handlers[beeblink.REQUEST_OPT] = new Handler('OPT', this.handleOPT);
        this.handlers[beeblink.REQUEST_BOOT_OPTION] = new Handler('GET_BOOT_OPTION', this.handleGetBootOption);
        this.handlers[beeblink.REQUEST_VOLUME_BROWSER] = new Handler('REQUEST_VOLUME_BROWSER', this.handleVolumeBrowser);
        this.handlers[beeblink.REQUEST_SPEED_TEST] = new Handler('REQUEST_SPEED_TEST', this.handleSpeedTest);
        this.handlers[beeblink.REQUEST_NEXT_DISK_IMAGE_PART] = new Handler('REQUEST_NEXT_DISK_IMAGE_PART', this.handleNextDiskImagePart);
        this.handlers[beeblink.REQUEST_SET_FILE_HANDLE_RANGE] = new Handler('REQUEST_SET_FILE_HANDLE_RANGE', this.handleSetFileHandleRange);

        this.log = new utils.Log(logPrefix !== undefined ? logPrefix : '', process.stderr, logPrefix !== undefined);
        this.log.colours = colours;
        this.dumpPackets = dumpPackets;
    }

    public async handleRequest(request: Request): Promise<Response> {
        this.dumpPacket(request);

        const response = await this.handleRequestInternal(request);

        this.dumpPacket(response);

        return response;
    }

    private dumpPacket(packet: Request | Response): void {
        if (this.dumpPackets) {
            let desc: string | undefined;
            let typeName: string;

            if (packet instanceof Request) {
                desc = utils.getRequestTypeName(packet.c);
                typeName = 'Request';
            } else {
                desc = utils.getResponseTypeName(packet.c);
                typeName = 'Response';
            }

            this.log.withIndent(`${typeName}: `, () => {
                this.log.p(`Type: ${packet.c} (0x${utils.hex2(packet.c)})`);
                if (desc !== undefined) {
                    this.log.p(` (${desc})`);
                }
                this.log.pn('');

                this.log.dumpBuffer(packet.p, 10);
            });
        }
    }

    private async handleRequestInternal(request: Request): Promise<Response> {
        try {
            const handler = this.handlers[request.c];
            if (handler === undefined) {
                return this.internalError('Unsupported request: &' + utils.hex2(request.c));
            } else {
                const logWasEnabled = this.log.enabled;
                if (handler.shouldLog()) {
                    this.log.in(handler.name + ': ');
                } else {
                    this.log.enabled = false;
                }

                try {
                    return await handler.applyFun(this, request.p);
                } finally {
                    if (handler.shouldLog()) {
                        this.log.out();
                        this.log.ensureBOL();
                    } else {
                        this.log.enabled = logWasEnabled;
                    }
                }
            }
        } catch (error) {
            if (error instanceof errors.BeebError) {
                this.log.pn('Error response: ' + error.toString());

                const builder = new utils.BufferBuilder();

                builder.writeUInt8(0);
                builder.writeUInt8(error.code);
                builder.writeString(error.text);
                builder.writeUInt8(0);

                return newResponse(beeblink.RESPONSE_ERROR, builder);
            } else {
                throw error;
            }
        }
    }

    private async handleGetROM(handler: Handler, p: Buffer): Promise<Response> {
        if (this.romPath === null) {
            return errors.generic('No ROM available');
        } else {
            try {
                const rom = await utils.fsReadFile(this.romPath);
                this.log.pn('ROM is ' + rom.length + ' bytes');
                return newResponse(beeblink.RESPONSE_DATA, rom);
            } catch (error) {
                return beebfs.BeebFS.throwServerError(error);
            }
        }
    }

    private async handleReset(handler: Handler, p: Buffer): Promise<Response> {
        this.log.pn('reset type=' + p[0]);

        if (p[0] === 1 || p[0] === 2) {
            // Power-on reset or CTRL+BREAK
            try {
                await this.bfs.reset();
            } catch (error) {
                if (error instanceof errors.BeebError) {
                    process.stderr.write('WARNING: error occured during reset: ' + error + '\n');
                } else {
                    throw error;
                }
            }
        }

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async handleEchoData(handler: Handler, p: Buffer): Promise<Response> {
        this.log.pn('Sending ' + p.length + ' byte(s) back...');
        return newResponse(beeblink.RESPONSE_DATA, p);
    }

    private async handleReadString(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 1);

        if (this.stringBuffer === undefined) {
            this.log.pn('string not present.');
            return newResponse(beeblink.RESPONSE_NO, 0);
        } else if (this.stringBufferIdx >= this.stringBuffer.length) {
            this.log.pn('string exhausted.');
            return newResponse(beeblink.RESPONSE_NO, 0);
        } else {
            let n = Math.min(this.stringBuffer.length - this.stringBufferIdx, p[0]);
            if (n === 0) {
                n = 1;
            }

            this.log.pn('sending ' + n + ' byte(s) out of ' + p[0] + ' requested');

            // still can't figure out how the Buffer API works from TypeScript.
            const result = Buffer.alloc(n);
            for (let i = 0; i < n; ++i) {
                result[i] = this.stringBuffer[this.stringBufferIdx + i];
            }

            this.stringBufferIdx += n;

            this.log.pn('result: ' + JSON.stringify(result.toString('binary')));

            return newResponse(beeblink.RESPONSE_DATA, result);
        }
    }

    private async handleStarCat(handler: Handler, p: Buffer): Promise<Response> {
        const commandLine = this.initCommandLine(p.toString('binary'));
        return this.textResponse(await this.bfs.getCAT(commandLine.parts.length > 0 ? commandLine.parts[0] : undefined));
    }

    private async handleStarCommand(handler: Handler, p: Buffer): Promise<Response> {
        const commandLine = this.initCommandLine(p.toString('binary'));

        if (commandLine.parts.length < 1) {
            return errors.badCommand();
        }

        let matchedCommand: Command | undefined;

        const part0UC = commandLine.parts[0].toUpperCase();

        for (const command of this.commands) {
            // Computers are so fast now that it's actually OK to do it like
            // this.
            for (let i = 0; i < command.nameUC.length; ++i) {
                let abbrevUC: string = command.nameUC.slice(0, 1 + i);

                if (abbrevUC.length < command.nameUC.length) {
                    abbrevUC += '.';
                    if (part0UC.substr(0, abbrevUC.length) === abbrevUC) {
                        // The '.' is a part separator, so split into two.
                        commandLine.parts.splice(0, 1, part0UC.substr(0, abbrevUC.length), part0UC.substr(abbrevUC.length));
                        matchedCommand = command;
                        break;
                    }
                } else {
                    if (part0UC === abbrevUC) {
                        matchedCommand = command;
                        break;
                    } else if (part0UC.length > abbrevUC.length && part0UC.substr(0, abbrevUC.length) === abbrevUC) {
                        // Not quite sure what the DFS rules are here exactly,
                        // but *DRIVEX tries to *RUN DRIVEX, *DRIVE0 selects
                        // drive 0, and *DRIVE- gives Bad Drive...
                        if (!utils.isalpha(part0UC[abbrevUC.length])) {
                            commandLine.parts.splice(0, 1, part0UC.substr(0, abbrevUC.length), part0UC.substr(abbrevUC.length));
                            matchedCommand = command;
                            break;
                        }
                    }
                }

                // Special case for emergency use.
                if (part0UC === 'BLFS_' + command.nameUC) {
                    matchedCommand = command;
                    break;
                }
            }

            if (matchedCommand !== undefined) {
                break;
            }
        }

        if (matchedCommand !== undefined) {
            try {
                return await matchedCommand.applyFun(this, commandLine);
            } catch (error) {
                if (error instanceof errors.BeebError) {
                    if (error.code === 220 && error.text === '') {
                        const text = 'Syntax: ' + matchedCommand.nameUC + (matchedCommand.syntax !== undefined ? ' ' + matchedCommand.syntax : '');
                        return errors.syntax(text);
                    }
                }

                throw error;
            }
        } else {
            return await this.handleRun(commandLine, true);//true = check library directory
        }
    }

    private async handleStarRun(handler: Handler, p: Buffer): Promise<Response> {
        const commandLine = this.initCommandLine(p.toString('binary'));
        return await this.handleRun(commandLine, false);//false = don't check library directory
    }

    private async handleHelpBLFS(handler: Handler, p: Buffer): Promise<Response> {
        let help = '';
        for (const command of this.commands) {
            help += '  ' + command.nameUC;
            if (command.syntax !== undefined) {
                help += ' ' + command.syntax;
            }
            help += BNL;
        }

        return this.textResponse(help);
    }

    private getOSFILEBlockString(b: Buffer) {
        return '[' +
            utils.hex8(b.readUInt32LE(0)) + ',' +
            utils.hex8(b.readUInt32LE(4)) + ',' +
            utils.hex8(b.readUInt32LE(8)) + ',' +
            utils.hex8(b.readUInt32LE(12)) +
            ']';
    }

    private async handleOSFILE(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBeAtLeast(handler, p, 17);

        let i = 0;

        const a = p[i];
        ++i;

        const block = Buffer.alloc(16);
        p.copy(block, 0, i);
        i += block.length;

        let nameString = '';
        while (i < p.length && p[i] !== 13) {
            nameString += String.fromCharCode(p[i]);
            ++i;
        }

        if (i >= p.length) {
            return errors.generic('Bad OSFILE request (2)');
        }

        ++i;//consume CR

        // You're supposed to be able to get Buffers to share storage, but I
        // can't figure out how to make that happen in TypeScript.
        const data = Buffer.alloc(p.length - i);

        p.copy(data, 0, i);

        this.log.pn('Name: ``' + nameString + '\'\'');
        this.log.pn('Input: A=0x' + utils.hex2(a) + ', ' + data.length + ' data byte(s)');

        const osfileResult = await this.bfs.OSFILE(a, nameString, block, data);

        this.log.p('Output: A=0x' + utils.hex2(osfileResult.fileType));
        if (osfileResult.block !== undefined) {
            this.log.p(', ' + this.getOSFILEBlockString(osfileResult.block));
        }
        if (osfileResult.data !== undefined) {
            this.log.p(', ' + osfileResult.data.length + ' data byte(s), load address 0x' + utils.hex8(osfileResult.dataLoad!));
        }
        this.log.p('\n');

        const builder = new utils.BufferBuilder();

        builder.writeUInt8(osfileResult.fileType);

        builder.writeBuffer(osfileResult.block !== undefined ? osfileResult.block : block);

        if (osfileResult.data !== undefined) {
            builder.writeUInt32LE(osfileResult.dataLoad!);
            builder.writeBuffer(osfileResult.data);
        }

        return newResponse(beeblink.RESPONSE_OSFILE, builder);
    }

    private async handleOSFINDOpen(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBeAtLeast(handler, p, 1);

        const mode = p[0];

        const nameString = p.toString('binary', 1);

        this.log.pn('Input: mode=0x' + utils.hex2(mode) + ', name=``' + nameString + '\'\'');

        const handle = await this.bfs.OSFINDOpen(mode, nameString);

        this.log.pn('Output: handle=' + utils.hexdec(handle));

        return newResponse(beeblink.RESPONSE_OSFIND, handle);
    }

    private async handleOSFINDClose(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 1);

        const handle = p[0];

        this.log.pn('Input: handle=' + utils.hexdec(handle));

        await this.bfs.OSFINDClose(handle);

        return newResponse(beeblink.RESPONSE_OSFIND, 0);
    }

    private async handleOSARGS(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 6);

        const a = p[0];
        const handle = p[1];
        const value = p.readUInt32LE(2);

        this.log.pn('Input: A=0x' + utils.hex2(a) + ', handle=' + utils.hexdec(handle) + ', value=0x' + utils.hex8(value));

        const newValue = await this.bfs.OSARGS(a, handle, value);

        this.log.pn('Output: value=0x' + utils.hex8(newValue));

        const responseData = Buffer.alloc(4);
        responseData.writeUInt32LE(newValue, 0);

        return newResponse(beeblink.RESPONSE_OSARGS, responseData);
    }

    private async handleEOF(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 1);

        const handle = p[0];

        const eof = this.bfs.eof(handle);

        return newResponse(beeblink.RESPONSE_EOF, eof ? 0xff : 0x00);
    }

    private async handleOSBGET(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 1);

        const handle = p[0];

        const byte = this.bfs.OSBGET(handle);

        this.log.p('Input: handle=' + utils.hexdec(handle) + '; Output: ' + (byte === undefined ? 'EOF' : 'value=' + utils.hexdecch(byte)));

        if (byte === undefined) {
            // 254 is what the Master 128 DFS returns, and who am I to argue?
            return newResponse(beeblink.RESPONSE_OSBGET_EOF, 254);
        } else {
            return newResponse(beeblink.RESPONSE_OSBGET, byte);
        }
    }

    private async handleOSBPUT(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 2);

        const handle = p[0];
        const byte = p[1];

        // 
        this.log.pn('Input: handle=' + utils.hexdec(handle) + ', value=' + utils.hexdecch(byte));

        this.bfs.OSBPUT(handle, byte);

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async handleStarInfo(handler: Handler, p: Buffer): Promise<Response> {
        const commandLine = this.initCommandLine(p.toString('binary'));

        if (commandLine.parts.length === 0) {
            return errors.badName();
        }

        const fqn = await this.bfs.parseFQN(commandLine.parts[0]);

        return await this.filesInfoResponse(fqn);
    }

    private async handleStarEx(handler: Handler, p: Buffer): Promise<Response> {
        const commandLine = this.initCommandLine(p.toString('binary'));

        let fqn;
        if (commandLine.parts.length === 0) {
            fqn = await this.bfs.parseFQN('*');
        } else {
            fqn = await this.bfs.parseFQN(commandLine.parts[0]);
        }

        return await this.filesInfoResponse(fqn);
    }

    private async handleOSGBPB(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBeAtLeast(handler, p, 14);

        let i = 0;

        const a = p[i];
        ++i;

        const handle = p[i];
        ++i;

        const addr = p.readUInt32LE(i);
        i += 4;

        const numBytes = p.readUInt32LE(i);
        i += 4;

        const newPtr = p.readUInt32LE(i);
        i += 4;

        const data = Buffer.alloc(p.length - i);
        p.copy(data, 0, i);
        i += p.length;

        this.log.pn('Input: A=0x' + utils.hex2(a) + ', handle=' + utils.hexdec(handle) + ', addr=0x' + utils.hex8(addr) + ', size=' + utils.hexdec(numBytes) + ', PTR#=' + utils.hexdec(newPtr) + ', ' + data.length + ' data bytes');

        const result = await this.bfs.OSGBPB(a, handle, numBytes, newPtr, data);

        this.log.withIndent('Output: ', () => {
            this.log.p('Output: C=' + result.c + ', addr=0x' + utils.hex8(addr) + ', bytes left=' + result.numBytesLeft + ', PTR#=' + result.ptr);
            if (result.data !== undefined) {
                this.log.p(', ' + result.data.length + ' data bytes');
            }
            this.log.p('\n');

            if (a >= 1 && a <= 4) {
                // Probably not actually all that interesting.
            } else {
                if (result.data !== undefined) {
                    this.log.dumpBuffer(result.data);
                }
            }
        });

        const builder = new utils.BufferBuilder();

        builder.writeUInt8(result.c ? 1 : 0);

        // OSGBPB A=8 modifies this... I just ignored that bit. But it gets sent
        // back anyway, just in case one day it turns out to be useful.
        builder.writeUInt8(handle);

        // This is a bit weird, but only one of input data and output data will
        // be set. (Also: the address could be updated on the 6502 end, but why
        // not do it here.)
        builder.writeUInt32LE(addr + data.length + (result.data !== undefined ? result.data.length : 0));

        builder.writeUInt32LE(result.numBytesLeft !== undefined ? result.numBytesLeft : numBytes);

        builder.writeUInt32LE(result.ptr !== undefined ? result.ptr : newPtr);

        if (result.data !== undefined) {
            builder.writeBuffer(result.data);
        }

        return newResponse(beeblink.RESPONSE_OSGBPB, builder);
    }

    private async handleOPT(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 2);

        const x = p[0];
        const y = p[1];

        this.log.pn('*OPT ' + x + ',' + y);

        await this.bfs.OPT(x, y);

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async handleGetBootOption(handler: Handler, p: Buffer): Promise<Response> {
        // const option = await beebfs.BeebFS.loadBootOption(this.bfs.getVolume(), this.bfs.getDrive());
        const option = await this.bfs.getBootOption();

        return newResponse(beeblink.RESPONSE_BOOT_OPTION, option);
    }

    private getBASICStringExpr(text: Buffer): string {
        let quotes = false;
        let r = '';

        for (let i = 0; i < text.length; ++i) {
            const v = text[i];
            if (v >= 32 && v < 126) {
                if (!quotes) {
                    if (i > 0) {
                        r += '+';
                    }

                    r += '"';
                    quotes = true;
                }

                const ch = String.fromCharCode(text[i]);
                if (ch === '"') {
                    r += '"';
                }

                r += ch;
            } else {
                if (quotes) {
                    r += '"+';
                    quotes = false;
                } else if (i > 0) {
                    r += '+';
                }

                r += 'CHR$(' + v + ')';
            }
        }

        if (quotes) {
            r += '"';
        }

        return r;
    }

    private async handleVolumeBrowser(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBeAtLeast(handler, p, 1);

        if (p[0] === beeblink.REQUEST_VOLUME_BROWSER_RESET) {
            this.log.pn('REQUEST_VOLUME_BROWSER_RESET');

            this.payloadMustBe(handler, p, 5);

            const charSizeBytes = p[1];
            const width = p[2];
            const height = p[3];
            const m128 = p[4] >= 3;

            const volumePaths = await this.bfs.findVolumesMatching('*');

            this.volumeBrowser = new volumebrowser.Browser(charSizeBytes, width, height, m128, volumePaths);

            const text = this.volumeBrowser.getInitialString();

            //this.log.pn('Browser initial string: ' + this.getBASICStringExpr(text));

            return this.textResponse(text);
        } else if (p[0] === beeblink.REQUEST_VOLUME_BROWSER_KEYPRESS && this.volumeBrowser !== undefined) {
            this.log.pn('REQUEST_VOLUME_BROWSER_KEYPRESS');

            this.payloadMustBe(handler, p, 3);

            const result = this.volumeBrowser.handleKey(p[2], p[1] !== 0);

            //this.log.pn('done=' + result.done + ', text=' + (result.text === undefined ? 'N/A' : this.getBASICStringExpr(result.text)));

            if (result.done) {
                let responseType = beeblink.RESPONSE_VOLUME_BROWSER_CANCELED;

                // bit lame, but the mount process will want to append a message...
                const builder = new utils.BufferBuilder();

                if (result.text.length > 0) {
                    builder.writeBuffer(result.text);
                }

                if (result.volume !== undefined) {
                    const volume = await this.bfs.mount(result.volume);
                    builder.writeString('New volume: ' + result.volume.name + BNL);

                    if (result.boot) {
                        responseType = beeblink.RESPONSE_VOLUME_BROWSER_BOOT;
                    } else {
                        responseType = beeblink.RESPONSE_VOLUME_BROWSER_MOUNTED;
                    }
                }

                this.textResponse(builder.createBuffer());

                return newResponse(beeblink.RESPONSE_VOLUME_BROWSER, responseType);
            } else if (result.text.length > 0) {
                this.textResponse(result.text);

                if (result.flushKeyboardBuffer) {
                    return newResponse(beeblink.RESPONSE_VOLUME_BROWSER, beeblink.RESPONSE_VOLUME_BROWSER_PRINT_STRING_AND_FLUSH_KEYBOARD_BUFFER);
                } else {
                    return newResponse(beeblink.RESPONSE_VOLUME_BROWSER, beeblink.RESPONSE_VOLUME_BROWSER_PRINT_STRING);
                }
            } else {
                return newResponse(beeblink.RESPONSE_VOLUME_BROWSER, beeblink.RESPONSE_VOLUME_BROWSER_KEY_IGNORED);
            }
        } else {
            return this.internalError('Bad ' + handler.name + ' request');
        }
    }

    private async handleSpeedTest(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBeAtLeast(handler, p, 1);

        if (p[0] === beeblink.REQUEST_SPEED_TEST_RESET) {
            this.log.pn('REQUEST_SPEED_TEST_RESET');

            this.speedTest = new speedtest.SpeedTest();

            return newResponse(beeblink.RESPONSE_YES);
        } else if (p[0] === beeblink.REQUEST_SPEED_TEST_TEST && this.speedTest !== undefined) {
            this.log.pn('REQUEST_SPEED_TEST_TEST');
            this.log.pn('payload size = 0x' + p.length.toString(16));

            this.payloadMustBeAtLeast(handler, p, 2);

            const parasite = p[1] !== 0;

            const data = Buffer.alloc(p.length - 2);
            p.copy(data, 0, 2);

            const responseData = this.speedTest.gotTestData(parasite, data, this.log);

            return newResponse(beeblink.RESPONSE_DATA, responseData);
        } else if (p[0] === beeblink.REQUEST_SPEED_TEST_STATS && this.speedTest !== undefined) {
            this.log.pn('REQUEST_SPEED_TEST_STATS');

            this.payloadMustBeAtLeast(handler, p, 10);

            const parasite = p[1] !== 0;
            const numBytes = p.readUInt32LE(2);
            const sendTimeSeconds = p.readUInt16LE(6) / 100;
            const recvTimeSeconds = p.readUInt16LE(8) / 100;

            this.speedTest.addStats(parasite, numBytes, sendTimeSeconds, recvTimeSeconds);

            return newResponse(beeblink.RESPONSE_YES);
        } else if (p[0] === beeblink.REQUEST_SPEED_TEST_DONE && this.speedTest !== undefined) {
            this.log.pn('REQUEST_SPEED_TEST_DONE');

            const s = this.speedTest.getString();

            this.log.withNoIndent(() => this.log.pn(s));

            return this.textResponse(s);
        } else {
            return this.internalError('Bad ' + handler.name + ' request');
        }
    }

    private async handleNextDiskImagePart(handler: Handler, p: Buffer): Promise<Response> {
        if (this.imageParts === undefined || this.imagePartIdx >= this.imageParts.length) {
            this.imageParts = undefined;
            return newResponse(beeblink.RESPONSE_NO);
        } else {
            return newResponse(beeblink.RESPONSE_DATA, this.imageParts[this.imagePartIdx++]);
        }
    }

    private async handleSetFileHandleRange(handler: Handler, p: Buffer): Promise<Response> {
        await this.bfs.setFileHandleRange(p[0], p[1]);

        return newResponse(beeblink.RESPONSE_YES);
    }

    private internalError(text: string): never {
        return errors.generic(text);
    }

    private payloadMustBeAtLeast(handler: Handler, p: Buffer, minSize: number) {
        if (p.length < minSize) {
            const message = 'Bad ' + handler.name + ' request';
            this.log.pn('Payload length = ' + p.length + ', but must be at least ' + minSize + ': ' + message);
            this.internalError(message);
        }
    }

    private payloadMustBe(handler: Handler, p: Buffer, size: number) {
        if (p.length !== size) {
            const message = 'Bad ' + handler.name + ' request';
            this.log.pn('Payload length = ' + p.length + ', but must be ' + size + ': ' + message);
            this.internalError(message);
        }
    }

    private async filesInfoResponse(afsp: beebfs.BeebFQN): Promise<Response> {
        const files = await this.bfs.findFilesMatching(afsp);

        if (files.length === 0) {
            return errors.fileNotFound();
        }

        let text = '';

        for (const file of files) {
            text += `${this.bfs.getInfoText(file)}${BNL}`;
        }

        return this.textResponse(text);
    }

    // private setString(...args: (number | string)[]) {
    //     if (args.length === 1 && typeof args[0] === 'string') {
    //         this.stringBuffer = Buffer.from(args[0] as string, 'binary');
    //     } else {
    //         const builder = new utils.BufferBuilder();

    //         for (const arg of args) {
    //             if (typeof arg === 'string') {
    //                 builder.writeString(arg);
    //             } else {
    //                 builder.writeUInt8(arg);
    //             }
    //         }

    //         this.stringBuffer = builder.createBuffer();
    //     }

    //     this.stringBufferIdx = 0;
    // }

    private textResponse(value: string | Buffer) {
        if (typeof value === 'string') {
            value = Buffer.from(value, 'binary');
        }

        this.stringBuffer = value;
        this.stringBufferIdx = 0;

        // ...args: (number | string)[]) {
        // this.setString(...args);

        return newResponse(beeblink.RESPONSE_TEXT, 0);
    }

    private initCommandLine(commandLineString: string): CommandLine {
        let commandLine: CommandLine;

        this.log.pn('command line=' + JSON.stringify(commandLineString));
        try {
            commandLine = new CommandLine(commandLineString);
        } catch (error) {
            if (error instanceof errors.BeebError) {
                this.log.pn('parse error: ' + error.toString());
            }

            throw error;
        }

        this.log.pn(commandLine.parts.length + ' part(s), Y=' + utils.hexdec(commandLine.getY()));
        for (let i = 0; i < commandLine.parts.length; ++i) {
            this.log.pn('[' + i + ']: ' + JSON.stringify(commandLine.parts[i]));
        }

        return commandLine;
    }

    private async handleRun(commandLine: CommandLine, tryLibDir: boolean): Promise<Response> {
        if (commandLine.parts.length === 0) {
            return errors.badName();
        }

        this.log.pn('*RUN: ``' + commandLine.parts[0] + '\'\' (try lib dir: ' + tryLibDir + ')');

        const fsp = await this.bfs.parseFileString(commandLine.parts[0]);
        const file = await this.bfs.getFileForRUN(fsp, tryLibDir);

        if (file.load === beebfs.SHOULDNT_LOAD || file.exec === beebfs.SHOULDNT_EXEC) {
            return errors.wont();
        }

        const data = await beebfs.BeebFS.readFile(file);

        const builder = new utils.BufferBuilder();

        builder.writeUInt8(commandLine.getY());
        builder.writeUInt32LE(file.load);
        builder.writeUInt32LE(file.exec);
        builder.writeBuffer(data);

        return newResponse(beeblink.RESPONSE_RUN, builder);
    }

    private async volsCommand(commandLine: CommandLine): Promise<Response> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : '*';

        const volumes = await this.bfs.findVolumesMatching(arg);

        let text = 'Matching volumes:';

        if (volumes.length === 0) {
            text += ' None';
        } else {
            volumes.sort((a, b) => utils.stricmp(a.name, b.name));

            for (const volume of volumes) {
                text += ' ' + volume.name;
            }

        }
        text += BNL;

        return this.textResponse(text);
    }

    private async filesCommand(commandLine: CommandLine): Promise<Response> {
        return this.textResponse(this.bfs.getOpenFilesOutput());
    }

    private async infoCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const fqn = await this.bfs.parseFQN(commandLine.parts[1]);
        return await this.filesInfoResponse(fqn);
    }

    private async accessCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        let attrString = '';
        if (commandLine.parts.length >= 3) {
            attrString = commandLine.parts[2];
        }

        const fqn = await this.bfs.parseFQN(commandLine.parts[1]);
        const beebFiles = await this.bfs.findFilesMatching(fqn);
        for (const beebFile of beebFiles) {
            // the validity of `attrString' will be checked over and over again,
            // which is kind of stupid.
            const newFile = this.bfs.getFileWithModifiedAttributes(beebFile, attrString);

            await this.bfs.writeBeebFileMetadata(newFile);
        }

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async deleteCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const fqn = await this.bfs.parseFQN(commandLine.parts[1]);

        await this.bfs.delete(fqn);

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async dirCommand(commandLine: CommandLine): Promise<Response> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : undefined;
        await this.bfs.starDir(arg);
        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async driveCommand(commandLine: CommandLine): Promise<Response> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : undefined;
        await this.bfs.starDrive(arg);

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async drivesCommand(commandLine: CommandLine): Promise<Response> {
        const text = await this.bfs.starDrives();

        return this.textResponse(text);
    }

    private async libCommand(commandLine: CommandLine): Promise<Response> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : undefined;
        await this.bfs.starLib(arg);
        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async typeCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length !== 2) {
            return errors.syntax();
        }

        const lines = await this.bfs.readTextFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFQN(commandLine.parts[1])));

        return this.textResponse(lines.join(BNL) + BNL);
    }

    private async listCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length !== 2) {
            return errors.syntax();
        }

        const lines = await this.bfs.readTextFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFQN(commandLine.parts[1])));

        let text = '';

        for (let i = 0; i < lines.length; ++i) {
            text += ((i + 1) % 10000).toString().padStart(4, ' ') + ' ' + lines[i] + BNL;
        }

        return this.textResponse(text);
    }

    private async locateCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const foundPaths = await this.bfs.starLocate(commandLine.parts[1]);

        let text = '';
        if (foundPaths.length === 0) {
            text += 'No files found.' + utils.BNL;
        } else {
            for (const foundPath of foundPaths) {
                text += `${foundPath}${utils.BNL}`;
            }
            // for (const foundFile of foundFiles) {
            //     text+=`${foundFile.getFullPath()}${utils.BNL}`;
            //     text += '::' + foundFile.name.volume.name + ':' + foundFile.name.drive + '.' + foundFile.name.dir + '.' + foundFile.name.name + utils.BNL;
            // }
        }

        return this.textResponse(text);
    }

    private async dumpCommand(commandLine: CommandLine): Promise<Response> {
        return await this.dumpCommandInternal(commandLine, false);
    }

    private async wdumpCommand(commandLine: CommandLine): Promise<Response> {
        return await this.dumpCommandInternal(commandLine, true);
    }

    private async dumpCommandInternal(commandLine: CommandLine, wide: boolean): Promise<Response> {
        if (commandLine.parts.length !== 2) {
            return errors.syntax();
        }

        const data = await beebfs.BeebFS.readFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFQN(commandLine.parts[1])));

        let text = '';

        const numColumns = wide ? 16 : 8;

        for (let i = 0; i < data.length; i += numColumns) {
            if (wide) {
                text += utils.hex8(i).toUpperCase() + ':';
            } else {
                text += utils.hex(i & 0xffffff, 6).toUpperCase();
            }

            for (let j = 0; j < numColumns; ++j) {
                text += ' ';
                if (i + j < data.length) {
                    text += utils.hex2(data[i + j]).toUpperCase();
                } else {
                    text += '  ';
                }
            }

            text += wide ? '  ' : ' ';

            for (let j = 0; j < numColumns; ++j) {
                if (i + j < data.length) {
                    const c = data[i + j];
                    if (c >= 32 && c < 127) {
                        text += String.fromCharCode(c);
                    } else {
                        text += '.';
                    }
                } else {
                    text += ' ';
                }
            }

            text += BNL;
        }

        return this.textResponse(text);
    }

    private async renameCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 3) {
            return errors.syntax();
        }

        const oldFQN = await this.bfs.parseFQN(commandLine.parts[1]);
        const newFQN = await this.bfs.parseFQN(commandLine.parts[2]);

        await this.bfs.rename(oldFQN, newFQN);

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async srloadCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length !== 4 && commandLine.parts.length !== 5) {
            return errors.syntax();
        }

        if (commandLine.parts.length >= 5) {
            if (commandLine.parts[4].toLowerCase() !== 'q') {
                return errors.syntax();
            }
        }

        const bank = utils.parseHex(commandLine.parts[3]);
        if (Number.isNaN(bank)) {
            return errors.syntax();
        }

        let addr = utils.parseHex(commandLine.parts[2]);
        if (Number.isNaN(addr)) {
            return errors.syntax();
        }

        addr &= 0xffff;

        const rom = await beebfs.BeebFS.readFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFQN(commandLine.parts[1])));

        this.log.pn(`Addr: 0x${utils.hex4(addr)}, bank: 0x${utils.hex2(addr)}, size: 0x${utils.hex4(rom.length)}`);

        if (addr < 0x8000 || addr + rom.length > 0xc000) {
            return errors.wont();
        }

        const builder = new utils.BufferBuilder();

        builder.writeUInt8(beeblink.RESPONSE_SPECIAL_SRLOAD);
        builder.writeUInt8(bank);
        builder.writeUInt16LE(addr);
        builder.writeBuffer(rom);

        return newResponse(beeblink.RESPONSE_SPECIAL, builder);
    }

    private async selfupdateCommand(commandLine: CommandLine): Promise<Response> {
        return newResponse(beeblink.RESPONSE_SPECIAL, beeblink.RESPONSE_SPECIAL_SELFUPDATE);
    }

    private async speedtestCommand(commandLine: CommandLine): Promise<Response> {
        let payload = beeblink.RESPONSE_SPECIAL_SPEED_TEST;
        if (commandLine.parts.length > 1) {
            if (commandLine.parts[1].toLowerCase() === 'y') {
                payload = beeblink.RESPONSE_SPECIAL_SPEED_TEST_SURE;
            }
        }

        return newResponse(beeblink.RESPONSE_SPECIAL, payload);
    }

    private async titleCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        await this.bfs.setTitle(commandLine.parts[1]);

        return newResponse(beeblink.RESPONSE_YES, 0);
    }

    private async volbrowserCommand(commandLine: CommandLine): Promise<Response> {
        return newResponse(beeblink.RESPONSE_SPECIAL, beeblink.RESPONSE_SPECIAL_VOLUME_BROWSER);
    }

    private async newvolCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const volume = await this.bfs.createVolume(commandLine.parts[1]);

        await this.bfs.mount(volume);

        return this.textResponse('New volume: ' + volume.name + BNL + 'Path: ' + volume.path + BNL);
    }

    private async volCommand(commandLine: CommandLine): Promise<Response> {
        let volume: beebfs.BeebVolume;
        if (commandLine.parts.length >= 2) {
            const volumes = await this.bfs.findVolumesMatching(commandLine.parts[1]);
            if (volumes.length === 0) {
                return errors.fileNotFound('Volume not found');
            }

            volume = volumes[0];

            if (commandLine.parts.length >= 3) {
                if (commandLine.parts[2].toLowerCase() === 'r') {
                    volume = volume.asReadOnly();
                }
            }

            await this.bfs.mount(volume);
        } else {
            volume = this.bfs.getVolume();
        }

        return this.textResponse('Volume: ' + volume.name + BNL + 'Path: ' + volume.path + BNL);
    }

    private async writeCommand(commandLine: CommandLine): Promise<Response> {
        if (commandLine.parts.length < 4) {
            return errors.syntax();
        }

        this.imageParts = undefined;
        this.imagePartIdx = 0;

        const fileName = commandLine.parts[1];
        const driveString = commandLine.parts[2];
        const type = commandLine.parts[3].toLowerCase();

        const data = await beebfs.BeebFS.readFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFQN(commandLine.parts[1])));

        if (driveString.length !== 1 || !utils.isdigit(driveString)) {
            return errors.syntax();
        }
        const drive: number = +driveString;

        if (type === 'a') {
            // there's only a 3-bit field for ADFS drives.
            if (drive < 0 || drive > 7) {
                return errors.badDrive();
            }

            const image = adfsimage.getADFSImage(data, drive, this.log);

            this.imageParts = image.parts;

            const p = Buffer.alloc(5);
            p[0] = beeblink.RESPONSE_SPECIAL_WRITE_ADFS_IMAGE;
            utils.setUInt24LE(p, 1, image.totalNumSectors);
            p[4] = drive;

            return newResponse(beeblink.RESPONSE_SPECIAL, p);
        } else if (type === 's') {
            this.imageParts = dfsimage.getSSDParts(data, drive, this.log);
            return newResponse(beeblink.RESPONSE_SPECIAL, beeblink.RESPONSE_SPECIAL_WRITE_DFS_IMAGE);
        } else if (type === 'd') {
            if (drive !== 0 && drive !== 1) {
                return errors.badDrive();
            }

            this.imageParts = dfsimage.getDSDParts(data, drive, this.log);

            return newResponse(beeblink.RESPONSE_SPECIAL, beeblink.RESPONSE_SPECIAL_WRITE_DFS_IMAGE);
        } else {
            return errors.syntax();
        }
    }
}
