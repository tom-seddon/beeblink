//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2018, 2019, 2020 Tom Seddon
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

import * as fs from 'fs';
import * as utils from './utils';
import * as beeblink from './beeblink';
import * as beebfs from './beebfs';
import * as volumebrowser from './volumebrowser';
import * as speedtest from './speedtest';
import * as dfsimage from './dfsimage';
import * as adfsimage from './adfsimage';
import * as crypto from 'crypto';
import { BNL } from './utils';
import Request from './Request';
import Response from './Response';
import * as errors from './errors';
import CommandLine from './CommandLine';
import * as diskimage from './diskimage';
import * as ddosimage from './ddosimage';

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

export class Command {
    public readonly nameUC: string;
    public readonly syntax: string | undefined;
    // Return undefined to respond with a YES response.
    //
    // Return string or Buffer to set up a text response with that as the text.
    //
    // Return Response to respond with that response.
    private readonly fun: (commandLine: CommandLine) => Promise<void | string | Buffer | Response>;
    private readonly thisAny: any;

    public constructor(name: string, syntax: string | undefined, thisAny: any, fun: (commandLine: CommandLine) => Promise<void | string | Response>) {
        this.nameUC = name.toUpperCase();
        this.syntax = syntax;
        this.fun = fun;
        this.thisAny = thisAny;
    }

    public async call(commandLine: CommandLine): Promise<void | string | Buffer | Response> {
        // JS crap that's seemingly impossible to deal with in any non-annoying way.
        return await this.fun.apply(this.thisAny, [commandLine]);
    }

    public getSyntaxString(): string {
        let syntax = this.nameUC;

        if (this.syntax !== undefined) {
            syntax += ` ${this.syntax}`;
        }

        return syntax;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Handler {
    public readonly name: string;
    private readonly fun: (handler: Handler, p: Buffer) => Promise<void | string | Buffer | Response>;
    private thisAny: any;
    private quiet: boolean;
    private fullRequestDump: boolean = false;
    private fullResponseDump: boolean = false;
    private resetLastOSBPUTHandle: boolean;

    public constructor(name: string, thisAny: any, fun: (handler: Handler, p: Buffer) => Promise<void | string | Buffer | Response>) {
        this.name = name;
        this.fun = fun;
        this.thisAny = thisAny;
        this.quiet = false;
        this.resetLastOSBPUTHandle = true;
    }

    public async call(p: Buffer): Promise<void | string | Buffer | Response> {
        // JS crap that's seemingly impossible to deal with in any non-annoying way.
        return await this.fun.apply(this.thisAny, [this, p]);
    }

    public shouldResetLastOSBPUTHandle(): boolean {
        return this.resetLastOSBPUTHandle;
    }

    public shouldLog(): boolean {
        return !this.quiet;
    }

    public withNoLogging(): Handler {
        this.quiet = true;
        return this;
    }

    public showFullRequestDump(): boolean {
        return this.fullRequestDump;
    }

    public showFullResponseDump(): boolean {
        return this.fullResponseDump;
    }

    public withFullRequestDump(): Handler {
        this.fullRequestDump = true;
        return this;
    }

    public withFullResponseDump(): Handler {
        this.fullResponseDump = true;
        return this;
    }

    public withoutResetLastOSBPUTHandle(): Handler {
        this.resetLastOSBPUTHandle = false;
        return this;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

enum DiskImageType {
    ADFS,
    SSD,
    DSD,
    SDD_DDOS,
    DDD_DDOS,
}

interface IDiskImageFlowDetails {
    bufferAddress: number;
    bufferSize: number;
    fileName: string;
    drive: number;
    type: DiskImageType;
    readAllSectors: boolean;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function encodeForOSCLI(command: string): Buffer {
    return Buffer.from(`${command}${String.fromCharCode(13)}`, 'binary');
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// This handles the front-end duties of decomposing payloads, parsing command
// lines, routing requests to the appropriate methods of BeebFS, and dealing
// with the packet writing. Try to isolate the lower levels from the packet
// format.

export class Server {
    private bfs: beebfs.FS;
    private linkSubtype: number | undefined;
    private romPathByLinkSubtype: Map<number, string>;
    private stringBuffer: Buffer | undefined;
    private stringBufferIdx: number;
    private commonCommands: Command[];
    private handlers: (Handler | undefined)[];
    private log: utils.Log | undefined;
    private volumeBrowser: volumebrowser.Browser | undefined;
    private speedTest: speedtest.SpeedTest | undefined;
    private dumpPackets: boolean;
    private diskImageFlow: diskimage.Flow | undefined;
    private linkSupportsFireAndForgetRequests: boolean;
    private lastOSBPUTHandle: number | undefined;

    public constructor(romPathByLinkSubtype: Map<number, string>, bfs: beebfs.FS, log: utils.Log | undefined, dumpPackets: boolean, linkSupportsFireAndForgetRequests: boolean) {
        this.romPathByLinkSubtype = romPathByLinkSubtype;
        this.linkSubtype = undefined;
        this.bfs = bfs;
        this.stringBufferIdx = 0;
        this.linkSupportsFireAndForgetRequests = linkSupportsFireAndForgetRequests;

        this.commonCommands = [
            new Command('ACCESS', '<afsp> (<mode>)', this, this.accessCommand),
            new Command('DEFAULTS', '([SRP])', this, this.defaultsCommand),
            new Command('DELETE', '<fsp>', this, this.deleteCommand),
            new Command('DIR', '(<dir>)', this, this.dirCommand),
            new Command('DRIVE', '(<drive>)', this, this.driveCommand),
            new Command('DUMP', '<fsp>', this, this.dumpCommand),
            new Command('HSTATUS', '([HFD])', this, this.hstatusCommand),
            new Command('INFO', '<afsp>', this, this.infoCommand),
            new Command('LIB', '(<dir>)', this, this.libCommand),
            new Command('LIST', '<fsp>', this, this.listCommand),
            new Command('LOCATE', '<afsp> (<format>)', this, this.locateCommand),
            new Command('NEWVOL', '<vsp>', this, this.newvolCommand),
            new Command('RENAME', '<old fsp> <new fsp>', this, this.renameCommand),
            new Command('SRLOAD', '<fsp> <addr> <bank> (Q)', this, this.srloadCommand),
            new Command('TITLE', '<title>', this, this.titleCommand),
            new Command('TYPE', '<fsp>', this, this.typeCommand),
            new Command('VOLBROWSER', undefined, this, this.volbrowserCommand),
            new Command('VOL', '(<avsp>) (R)', this, this.volCommand),
            new Command('VOLS', '(<avsp>)', this, this.volsCommand),
            new Command('WDUMP', '<fsp>', this, this.wdumpCommand),
            new Command('WINFO', '<afsp>', this, this.winfoCommand),
        ];

        this.handlers = [];
        this.handlers[beeblink.REQUEST_GET_ROM] = new Handler('GET_ROM', this, this.handleGetROM);
        this.handlers[beeblink.REQUEST_RESET] = new Handler('RESET', this, this.handleReset);
        this.handlers[beeblink.REQUEST_ECHO_DATA] = new Handler('ECHO_DATA', this, this.handleEchoData);
        this.handlers[beeblink.REQUEST_READ_STRING] = new Handler('READ_STRING', this, this.handleReadString).withNoLogging();
        this.handlers[beeblink.REQUEST_READ_STRING_VERBOSE] = new Handler('READ_STRING_VERBOSE', this, this.handleReadString);
        this.handlers[beeblink.REQUEST_STAR_CAT] = new Handler('STAR_CAT', this, this.handleStarCat);
        this.handlers[beeblink.REQUEST_STAR_COMMAND] = new Handler('STAR_COMMAND', this, this.handleStarCommand);
        this.handlers[beeblink.REQUEST_STAR_RUN] = new Handler('STAR_RUN', this, this.handleStarRun);
        this.handlers[beeblink.REQUEST_HELP_BLFS] = new Handler('HELP_BLFS', this, this.handleHelpBLFS);
        this.handlers[beeblink.REQUEST_OSFILE] = new Handler('OSFILE', this, this.handleOSFILE);
        this.handlers[beeblink.REQUEST_OSFIND_OPEN] = new Handler('OSFIND_OPEN', this, this.handleOSFINDOpen);
        this.handlers[beeblink.REQUEST_OSFIND_CLOSE] = new Handler('OSFIND_CLOSE', this, this.handleOSFINDClose);
        this.handlers[beeblink.REQUEST_OSARGS] = new Handler('OSARGS', this, this.handleOSARGS);
        this.handlers[beeblink.REQUEST_EOF] = new Handler('EOF', this, this.handleEOF);
        this.handlers[beeblink.REQUEST_OSBGET] = new Handler('OSBGET', this, this.handleOSBGET);//.withNoLogging();
        this.handlers[beeblink.REQUEST_OSBPUT] = new Handler('OSBPUT', this, this.handleOSBPUT).withoutResetLastOSBPUTHandle();//.withNoLogging();
        this.handlers[beeblink.REQUEST_STAR_INFO] = new Handler('STAR_INFO', this, this.handleStarInfo);
        this.handlers[beeblink.REQUEST_STAR_EX] = new Handler('STAR_EX', this, this.handleStarEx);
        this.handlers[beeblink.REQUEST_OSGBPB] = new Handler('OSGBPB', this, this.handleOSGBPB);
        this.handlers[beeblink.REQUEST_OPT] = new Handler('OPT', this, this.handleOPT);
        this.handlers[beeblink.REQUEST_BOOT_OPTION] = new Handler('REQUEST_BOOT_OPTION', this, this.handleGetBootOption);
        this.handlers[beeblink.REQUEST_VOLUME_BROWSER] = new Handler('VOLUME_BROWSER', this, this.handleVolumeBrowser);
        this.handlers[beeblink.REQUEST_SPEED_TEST] = new Handler('SPEED_TEST', this, this.handleSpeedTest);
        this.handlers[beeblink.REQUEST_SET_FILE_HANDLE_RANGE] = new Handler('SET_FILE_HANDLE_RANGE', this, this.handleSetFileHandleRange);
        this.handlers[beeblink.REQUEST_SET_DISK_IMAGE_CAT] = new Handler('SET_DISK_IMAGE_CAT', this, this.handleSetDiskImageCat).withFullRequestDump();
        this.handlers[beeblink.REQUEST_NEXT_DISK_IMAGE_PART] = new Handler('NEXT_DISK_IMAGE_part', this, this.handleNextDiskImagePart);
        this.handlers[beeblink.REQUEST_SET_LAST_DISK_IMAGE_OSWORD_RESULT] = new Handler('SET_LAST_DISK_IMAGE_OSWORD_RESULT', this, this.handleSetLastDiskImageOSWORDResult);
        this.handlers[beeblink.REQUEST_FINISH_DISK_IMAGE_FLOW] = new Handler('FINISH_DISK_IMAGE_FLOW', this, this.handleFinishDiskImageFlow);
        this.handlers[beeblink.REQUEST_WRAPPED] = new Handler('REQUEST_WRAPPED', this, this.handleWrapped);
        this.handlers[beeblink.REQUEST_READ_DISK_IMAGE] = new Handler('REQUEST_READ_DISK_IMAGE', this, this.handleReadDiskImage);
        this.handlers[beeblink.REQUEST_WRITE_DISK_IMAGE] = new Handler('REQUEST_WRITE_DISK_IMAGE', this, this.handleWriteDiskImage);

        if (this.linkSupportsFireAndForgetRequests) {
            this.handlers[beeblink.REQUEST_OSBPUT_FNF] = new Handler('OSBPUT_FNF', this, this.handleOSBPUTFireAndForget).withoutResetLastOSBPUTHandle();//.withNoLogging();
        }

        this.log = log;
        this.dumpPackets = dumpPackets;
    }

    public async handleRequest(request: Request): Promise<Response> {
        const handler = this.handlers[request.c];

        this.dumpPacket(request, handler !== undefined && handler.showFullRequestDump());

        const response = await this.handleRequestInternal(handler, request);

        this.dumpPacket(response, handler !== undefined && handler.showFullResponseDump());

        if (handler === undefined || handler.shouldResetLastOSBPUTHandle()) {
            this.lastOSBPUTHandle = undefined;
        }

        return response;
    }

    private dumpPacket(packet: Request | Response, fullDump: boolean): void {
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

            this.log?.withIndent(`${typeName}: `, () => {
                this.log!.p(`Type: ${packet.c} (0x${utils.hex2(packet.c)})`);
                if (desc !== undefined) {
                    this.log!.p(` (${desc})`);
                }
                this.log!.p(` (${packet.p.length} (0x${utils.hex8(packet.p.length)}) byte(s)`);
                this.log!.pn('');

                this.log!.dumpBuffer(packet.p, fullDump ? undefined : 10);
            });
        }
    }

    private getResponseForResult(result: void | string | Buffer | Response): Response {
        if (result === undefined) {
            return newResponse(beeblink.RESPONSE_YES);
        } else if (typeof (result) === 'string' || result instanceof Buffer) {
            this.prepareForTextResponse(result);
            return newResponse(beeblink.RESPONSE_TEXT);
        } else {
            return result;
        }
    }

    private async handleRequestInternal(handler: Handler | undefined, request: Request): Promise<Response> {
        try {
            if (handler === undefined) {
                return this.internalError('Unsupported request: &' + utils.hex2(request.c));
            } else {
                const logWasEnabled = utils.Log.isEnabled(this.log);
                if (handler.shouldLog()) {
                    this.log?.in(handler.name + ': ');
                } else {
                    utils.Log.setEnabled(this.log, false);
                }

                try {
                    return this.getResponseForResult(await handler.call(request.p));
                } finally {
                    if (handler.shouldLog()) {
                        this.log?.out();
                        this.log?.ensureBOL();
                    } else {
                        utils.Log.setEnabled(this.log, logWasEnabled);
                    }
                }
            }
        } catch (error) {
            if (error instanceof errors.BeebError) {
                this.log?.pn('Error response: ' + error.toString());

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
        if (this.romPathByLinkSubtype.size === 0) {
            return errors.generic('No ROM available');
        } else if (this.linkSubtype === undefined) {
            return errors.generic('Link subtype not set');
        } else {
            const romPath = this.romPathByLinkSubtype.get(this.linkSubtype);
            if (romPath === undefined) {
                return errors.generic('No ROM for link subtype');
            } else {
                try {
                    const rom = await utils.fsReadFile(romPath);
                    this.log?.pn('ROM is ' + rom.length + ' bytes');
                    return newResponse(beeblink.RESPONSE_DATA, rom);
                } catch (error) {
                    return errors.nodeError(error);
                }
            }
        }
    }

    private async handleReset(handler: Handler, p: Buffer): Promise<void> {
        this.log?.pn('reset type=' + p[0]);
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

        if (p.length > 1) {
            this.linkSubtype = p[1];
            this.log?.pn(`link subtype=${this.linkSubtype}`);
        } else {
            this.linkSubtype = 0;
            this.log?.pn(`link subtype=${this.linkSubtype} (inferred)`);
        }
    }

    private async handleEchoData(handler: Handler, p: Buffer): Promise<Response> {
        this.log?.pn('Sending ' + p.length + ' byte(s) back...');
        return newResponse(beeblink.RESPONSE_DATA, p);
    }

    private async handleReadString(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 1);

        if (this.stringBuffer === undefined) {
            this.log?.pn('string not present.');
            return newResponse(beeblink.RESPONSE_NO, 0);
        } else if (this.stringBufferIdx >= this.stringBuffer.length) {
            this.log?.pn('string exhausted.');
            return newResponse(beeblink.RESPONSE_NO, 0);
        } else {
            let n = Math.min(this.stringBuffer.length - this.stringBufferIdx, p[0]);
            if (n === 0) {
                n = 1;
            }

            this.log?.pn('sending ' + n + ' byte(s) out of ' + p[0] + ' requested');

            // still can't figure out how the Buffer API works from TypeScript.
            const result = Buffer.alloc(n);
            for (let i = 0; i < n; ++i) {
                result[i] = this.stringBuffer[this.stringBufferIdx + i];
            }

            this.stringBufferIdx += n;

            this.log?.pn('result: ' + JSON.stringify(result.toString('binary')));

            return newResponse(beeblink.RESPONSE_DATA, result);
        }
    }

    private async handleStarCat(handler: Handler, p: Buffer): Promise<string> {
        // the command line in this case does not include the *CAT itself...
        const commandLine = this.initCommandLine(p.toString('binary'));

        return this.bfs.getCAT(commandLine.parts.length >= 1 ? commandLine.parts[0] : undefined);
    }

    private matchStarCommand(nameUC: string, commandLine: CommandLine): boolean {
        const part0UC = commandLine.parts[0].toUpperCase();

        for (let i = 0; i < nameUC.length; ++i) {
            let abbrevUC: string = nameUC.slice(0, 1 + i);

            if (abbrevUC.length < nameUC.length) {
                abbrevUC += '.';
                if (part0UC === abbrevUC) {
                    return true;
                } else if (part0UC.substring(0, abbrevUC.length) === abbrevUC) {
                    // The '.' is a part separator, so split into two.
                    commandLine.parts.splice(0, 1, part0UC.substring(0, abbrevUC.length), part0UC.substring(abbrevUC.length));
                    return true;
                }
            } else {
                if (part0UC === abbrevUC) {
                    return true;
                } else if (part0UC.length > abbrevUC.length && part0UC.substring(0, abbrevUC.length) === abbrevUC) {
                    // Not quite sure what the DFS rules are here exactly,
                    // but *DRIVEX tries to *RUN DRIVEX, *DRIVE0 selects
                    // drive 0, and *DRIVE- gives Bad Drive...
                    if (!utils.isalpha(part0UC[abbrevUC.length])) {
                        commandLine.parts.splice(0, 1, part0UC.substring(0, abbrevUC.length), part0UC.substring(abbrevUC.length));
                        return true;
                    }
                }
            }

            // Special case for emergency use.
            if (part0UC === 'BLFS_' + nameUC) {
                return true;
            }
        }

        return false;
    }

    // // it's a bit wasteful having the list regenerated every time... luckily the
    // // PC is fast, and the BBC is slow...
    // //
    // // Should really do a bit better though.
    // private getCommands(): Command[] {
    //     const commands = [];

    //     for (const command of this.commonCommands) {
    //         commands.push(command);
    //     }

    //     for (const command of this.bfs.getCommands()) {
    //         commands.push(command);
    //     }

    //     return commands;
    // }

    private async handleStarCommand(handler: Handler, p: Buffer): Promise<Response> {
        const commandLine = this.initCommandLine(p.toString('binary'));

        if (commandLine.parts.length < 1) {
            return errors.badCommand();
        }

        this.log?.pn(`${commandLine.parts.length} command line parts:`);
        for (let i = 0; i < commandLine.parts.length; ++i) {
            this.log?.pn(`    ${i}. "${commandLine.parts[i]}"`);
        }

        let matchedCommand: Command | undefined;

        for (const command of this.commonCommands) {
            if (this.matchStarCommand(command.nameUC, commandLine)) {
                matchedCommand = command;
                break;
            }
        }

        if (matchedCommand === undefined) {
            for (const command of this.bfs.getCommands()) {
                if (this.matchStarCommand(command.nameUC, commandLine)) {
                    matchedCommand = command;
                    break;
                }
            }
        }

        if (matchedCommand !== undefined) {
            this.log?.pn('Matched command: ' + matchedCommand.getSyntaxString());
            try {
                return this.getResponseForResult(await matchedCommand.call(commandLine));
            } catch (error) {
                if (error instanceof errors.BeebError) {
                    if (error.code === 220 && error.text === '') {
                        return errors.syntax(`Syntax: ${matchedCommand.getSyntaxString()}`);
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

    private async handleHelpBLFS(handler: Handler, p: Buffer): Promise<string> {
        let help = '';

        for (const command of this.commonCommands) {
            help += `  ${command.getSyntaxString()}${BNL}`;
        }

        const extraCommands = this.bfs.getCommands();
        if (extraCommands.length > 0) {
            help += ` Volume-specific:${BNL}`;
            for (const command of extraCommands) {
                help += `  ${command.getSyntaxString()}${BNL}`;
            }

        }

        return help;
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

        this.log?.pn('Name: ``' + nameString + '\'\'');
        this.log?.pn('Input: A=0x' + utils.hex2(a) + ', ' + data.length + ' data byte(s)');

        const osfileResult = await this.bfs.OSFILE(a, nameString, block, data);

        this.log?.p('Output: A=0x' + utils.hex2(osfileResult.fileType));
        if (osfileResult.block !== undefined) {
            this.log?.p(', ' + this.getOSFILEBlockString(osfileResult.block));
        }
        if (osfileResult.data !== undefined) {
            this.log?.p(', ' + osfileResult.data.length + ' data byte(s), load address 0x' + utils.hex8(osfileResult.dataLoad!));
        }
        this.log?.p('\n');

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

        this.log?.pn('Input: mode=0x' + utils.hex2(mode) + ', name=``' + nameString + '\'\'');

        const handle = await this.bfs.OSFINDOpen(mode, nameString);

        this.log?.pn('Output: handle=' + utils.hexdec(handle));

        return newResponse(beeblink.RESPONSE_OSFIND, handle);
    }

    private async handleOSFINDClose(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 1);

        const handle = p[0];

        this.log?.pn('Input: handle=' + utils.hexdec(handle));

        await this.bfs.OSFINDClose(handle);

        return newResponse(beeblink.RESPONSE_OSFIND, 0);
    }

    private async handleOSARGS(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 6);

        const a = p[0];
        const handle = p[1];
        const value = p.readUInt32LE(2);

        this.log?.pn('Input: A=0x' + utils.hex2(a) + ', handle=' + utils.hexdec(handle) + ', value=0x' + utils.hex8(value));

        const newValue = await this.bfs.OSARGS(a, handle, value);

        this.log?.pn('Output: value=0x' + utils.hex8(newValue));

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

        this.log?.p('Input: handle=' + utils.hexdec(handle) + '; Output: ' + (byte === undefined ? 'EOF' : 'value=' + utils.hexdecch(byte)));

        if (byte === undefined) {
            // 254 is what the Master 128 DFS returns, and who am I to argue?
            return newResponse(beeblink.RESPONSE_OSBGET_EOF, 254);
        } else {
            return newResponse(beeblink.RESPONSE_OSBGET, byte);
        }
    }

    private async handleOSBPUTFireAndForget(handler: Handler, p: Buffer): Promise<void> {
        let byte: number;
        let handle: number;
        if (p.length === 1) {
            if (this.lastOSBPUTHandle === undefined) {
                this.internalError('No previous OSBPUT');
            }

            handle = this.lastOSBPUTHandle;
            byte = p[0];
        } else if (p.length === 2) {
            handle = p[0];
            byte = p[1];
        } else {
            this.internalError('Bad OSBPUT payload');
        }

        this.log?.pn('Input: handle=' + utils.hexdec(handle) + ', value=' + utils.hexdecch(byte));
        this.bfs.OSBPUT(handle, byte);
        this.lastOSBPUTHandle = handle;
    }

    private async handleOSBPUT(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBe(handler, p, 2);

        const handle = p[0];
        const byte = p[1];

        //
        this.log?.pn('Input: handle=' + utils.hexdec(handle) + ', value=' + utils.hexdecch(byte));

        const newPtr = this.bfs.OSBPUT(handle, byte);
        this.lastOSBPUTHandle = handle;

        if (this.linkSupportsFireAndForgetRequests) {
            const numOSBPUTsLeft = Math.min(beebfs.MAX_FILE_SIZE - newPtr, 255);

            this.log?.pn(`Output: FNF OSBPUT counter=${numOSBPUTsLeft}`);

            return newResponse(beeblink.RESPONSE_OSBPUT, numOSBPUTsLeft);
        } else {
            return newResponse(beeblink.RESPONSE_YES, 0);
        }
    }

    private async handleStarInfo(handler: Handler, p: Buffer): Promise<string> {
        const commandLine = this.initCommandLine(p.toString('binary'));

        if (commandLine.parts.length === 0) {
            return errors.badName();
        }

        const fqn = await this.bfs.parseFileString(commandLine.parts[0]);

        return await this.filesInfoResponse(fqn);
    }

    private async handleStarEx(handler: Handler, p: Buffer): Promise<string> {
        const commandLine = this.initCommandLine(p.toString('binary'));

        let fqn;
        if (commandLine.parts.length === 0) {
            fqn = await this.bfs.parseFileString('*');
        } else {
            fqn = await this.bfs.parseFileString(commandLine.parts[0]);
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

        this.log?.pn('Input: A=0x' + utils.hex2(a) + ', handle=' + utils.hexdec(handle) + ', addr=0x' + utils.hex8(addr) + ', size=' + utils.hexdec(numBytes) + ', PTR#=' + utils.hexdec(newPtr) + ', ' + data.length + ' data bytes');

        const result = await this.bfs.OSGBPB(a, handle, numBytes, newPtr, data);

        this.log?.withIndent('Output: ', () => {
            this.log!.p('Output: C=' + result.c + ', addr=0x' + utils.hex8(addr) + ', bytes left=' + result.numBytesLeft + ', PTR#=' + result.ptr);
            if (result.data !== undefined) {
                this.log!.p(', ' + result.data.length + ' data bytes');
            }
            this.log!.p('\n');

            if (a >= 1 && a <= 4) {
                // Probably not actually all that interesting.
            } else {
                if (result.data !== undefined) {
                    this.log!.dumpBuffer(result.data);
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

    private async handleOPT(handler: Handler, p: Buffer): Promise<void> {
        this.payloadMustBe(handler, p, 2);

        const x = p[0];
        const y = p[1];

        this.log?.pn('*OPT ' + x + ',' + y);

        await this.bfs.OPT(x, y);
    }

    private async handleGetBootOption(handler: Handler, p: Buffer): Promise<Response> {
        // const option = await beebfs.BeebFS.loadBootOption(this.bfs.getVolume(), this.bfs.getDrive());
        const option = await this.bfs.getBootOption();

        this.log?.pn(`Boot option: ${option}`);

        return newResponse(beeblink.RESPONSE_BOOT_OPTION, option);
    }

    private async handleVolumeBrowser(handler: Handler, p: Buffer): Promise<Buffer | Response> {
        this.payloadMustBeAtLeast(handler, p, 1);

        if (p[0] === beeblink.REQUEST_VOLUME_BROWSER_RESET) {
            this.log?.pn('REQUEST_VOLUME_BROWSER_RESET');

            this.payloadMustBe(handler, p, 5);

            const charSizeBytes = p[1];
            const width = p[2];
            const height = p[3];
            const m128 = p[4] >= 3;

            const volumePaths = await this.bfs.findAllVolumesMatching('*');

            this.volumeBrowser = new volumebrowser.Browser(charSizeBytes, width, height, m128, volumePaths);

            const text = this.volumeBrowser.getInitialString();

            //this.log?.pn('Browser initial string: ' + this.getBASICStringExpr(text));

            return text;
        } else if (p[0] === beeblink.REQUEST_VOLUME_BROWSER_KEYPRESS && this.volumeBrowser !== undefined) {
            this.log?.pn('REQUEST_VOLUME_BROWSER_KEYPRESS');

            this.payloadMustBe(handler, p, 3);

            const result = this.volumeBrowser.handleKey(p[2], p[1] !== 0);

            //this.log?.pn('done=' + result.done + ', text=' + (result.text === undefined ? 'N/A' : this.getBASICStringExpr(result.text)));

            if (result.done) {
                let responseType = beeblink.RESPONSE_VOLUME_BROWSER_CANCELED;

                // bit lame, but the mount process will want to append a message...
                const builder = new utils.BufferBuilder();

                if (result.text.length > 0) {
                    builder.writeBuffer(result.text);
                }

                if (result.volume !== undefined) {
                    await this.bfs.mount(result.volume);
                    builder.writeString('New volume: ' + result.volume.name + BNL);

                    if (result.boot) {
                        responseType = beeblink.RESPONSE_VOLUME_BROWSER_BOOT;
                    } else {
                        responseType = beeblink.RESPONSE_VOLUME_BROWSER_MOUNTED;
                    }
                }

                this.prepareForTextResponse(builder.createBuffer());

                return newResponse(beeblink.RESPONSE_VOLUME_BROWSER, responseType);
            } else if (result.text.length > 0) {
                this.prepareForTextResponse(result.text);

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

    private async handleSpeedTest(handler: Handler, p: Buffer): Promise<string | Response> {
        this.payloadMustBeAtLeast(handler, p, 1);

        if (p[0] === beeblink.REQUEST_SPEED_TEST_RESET) {
            this.log?.pn('REQUEST_SPEED_TEST_RESET');

            this.speedTest = new speedtest.SpeedTest();

            return newResponse(beeblink.RESPONSE_YES);
        } else if (p[0] === beeblink.REQUEST_SPEED_TEST_TEST && this.speedTest !== undefined) {
            this.log?.pn('REQUEST_SPEED_TEST_TEST');
            this.log?.pn('payload size = 0x' + p.length.toString(16));

            this.payloadMustBeAtLeast(handler, p, 2);

            const parasite = p[1] !== 0;

            const data = Buffer.alloc(p.length - 2);
            p.copy(data, 0, 2);

            const responseData = this.speedTest.gotTestData(parasite, data, this.log);

            return newResponse(beeblink.RESPONSE_DATA, responseData);
        } else if (p[0] === beeblink.REQUEST_SPEED_TEST_STATS && this.speedTest !== undefined) {
            this.log?.pn('REQUEST_SPEED_TEST_STATS');

            this.payloadMustBeAtLeast(handler, p, 6);

            const parasite = p[1] !== 0;
            const numBytes = p.readUInt32LE(2);

            this.speedTest.addStats(parasite, numBytes);

            return newResponse(beeblink.RESPONSE_YES);
        } else if (p[0] === beeblink.REQUEST_SPEED_TEST_DONE && this.speedTest !== undefined) {
            this.log?.pn('REQUEST_SPEED_TEST_DONE');

            const s = this.speedTest.getString();

            this.log?.withNoIndent(() => this.log?.pn(s));

            return s;
        } else {
            return this.internalError('Bad ' + handler.name + ' request');
        }
    }

    private async handleSetFileHandleRange(handler: Handler, p: Buffer): Promise<void> {
        await this.bfs.setFileHandleRange(p[0], p[1]);
    }

    private writeOSWORDBlock(osword: diskimage.IDiskOSWORD | undefined, builder: utils.BufferBuilder, blockAddressOffset: number | undefined, errorAddressOffset: number | undefined): number | undefined {
        if (osword !== undefined) {
            const offset = builder.getLength();

            builder.setUInt32LE(builder.getNextAddress(), blockAddressOffset!);

            builder.setUInt32LE(builder.getNextAddress() + diskimage.getDiskOSWORDErrorOffset(osword), errorAddressOffset!);

            builder.writeBuffer(osword.block);

            return offset + diskimage.getDiskOSWORDAddressOffset(osword);
        } else {
            return undefined;
        }
    }

    private writeCRTerminatedString(str: string, builder: utils.BufferBuilder, stringAddressOffset: number): void {
        builder.setUInt32LE(builder.getNextAddress(), stringAddressOffset);

        builder.writeString(str);
        builder.writeUInt8(13);
    }

    private async startDiskImageFlow(diskImageFlow: diskimage.Flow, bufferAddress: number, bufferSize: number): Promise<Response> {
        this.diskImageFlow = diskImageFlow;

        const start = this.diskImageFlow.start(bufferAddress, bufferSize);

        const builder = new utils.BufferBuilder(bufferAddress);

        builder.writeUInt8(start.fs);
        const fsStarCommandAddressOffset = builder.writeUInt32LE(0);
        const starCommandAddressOffset = builder.writeUInt32LE(0);

        builder.writeUInt8(start.osword1 !== undefined ? start.osword1.reason : 0);
        const osword1BlockAddressOffset = builder.writeUInt32LE(0);
        const osword1ErrorAddressOffset = builder.writeUInt32LE(0);
        const osword1TransferSizeBytes = start.osword1 !== undefined ? diskimage.getDiskOSWORDTransferSizeBytes(start.osword1) : 0;

        builder.writeUInt8(start.osword2 !== undefined ? start.osword2.reason : 0);
        const osword2BlockAddressOffset = builder.writeUInt32LE(0);
        const osword2ErrorAddressOffset = builder.writeUInt32LE(0);
        const osword2TransferSizeBytes = start.osword2 !== undefined ? diskimage.getDiskOSWORDTransferSizeBytes(start.osword2) : 0;

        const catPayloadAddressOffset = builder.writeUInt32LE(0);
        builder.writeUInt32LE(osword1TransferSizeBytes + osword2TransferSizeBytes);

        this.writeCRTerminatedString(start.fsStarCommand, builder, fsStarCommandAddressOffset);
        this.writeCRTerminatedString(start.starCommand, builder, starCommandAddressOffset);

        const osword1DataAddressOffset = this.writeOSWORDBlock(start.osword1, builder, osword1BlockAddressOffset, osword1ErrorAddressOffset);
        const osword2DataAddressOffset = this.writeOSWORDBlock(start.osword2, builder, osword2BlockAddressOffset, osword2ErrorAddressOffset);

        builder.setUInt32LE(builder.getNextAddress(), catPayloadAddressOffset);
        builder.maybeSetUInt32LE(builder.getNextAddress(), osword1DataAddressOffset);
        builder.maybeSetUInt32LE(builder.getNextAddress() + osword1TransferSizeBytes, osword2DataAddressOffset);

        return newResponse(beeblink.RESPONSE_DATA, builder.createBuffer());
    }

    private async handleSetDiskImageCat(handler: Handler, p: Buffer): Promise<void> {
        if (this.diskImageFlow === undefined) {
            return errors.generic(`No disk image flow`);
        }

        this.diskImageFlow.setCat(p);
    }

    private async handleNextDiskImagePart(handler: Handler, p: Buffer): Promise<Response> {
        if (this.diskImageFlow === undefined) {
            return errors.generic(`No disk image flow`);
        }

        const part = this.diskImageFlow.getNextPart();
        if (part === undefined) {
            return newResponse(beeblink.RESPONSE_NO);
        } else {
            const builder = new utils.BufferBuilder(this.diskImageFlow.getBufferAddress());

            builder.writeUInt8(part.osword.reason);
            const oswordBlockAddressOffset = builder.writeUInt32LE(0);
            const oswordBlockErrorAddressOffset = builder.writeUInt32LE(0);
            const messageAddressOffset = builder.writeUInt32LE(0);
            const resultPayloadAddressOffset = builder.writeUInt32LE(0);
            const resultPayloadSizeOffset = builder.writeUInt32LE(0);

            // Add CR-terminated message.
            this.writeCRTerminatedString(part.message, builder, messageAddressOffset);

            // Add OSWORD parameter block.
            const dataAddressOffset = this.writeOSWORDBlock(part.osword, builder, oswordBlockAddressOffset, oswordBlockErrorAddressOffset)!;

            // Add buffer.
            builder.setUInt32LE(builder.getNextAddress(), dataAddressOffset); //oswordBlockOffset + diskimage.getDiskOSWORDAddressOffset(part.osword));
            if (part.osword.data === undefined) {
                // Read operation. Set up payload.
                builder.setUInt32LE(builder.getNextAddress(), resultPayloadAddressOffset);
                builder.setUInt32LE(diskimage.getDiskOSWORDTransferSizeBytes(part.osword), resultPayloadSizeOffset);
            } else {
                // Write operation. Add data to read, and leave the result
                // payload as-was.
                builder.writeBuffer(part.osword.data);
            }

            return newResponse(beeblink.RESPONSE_DATA, builder.createBuffer());
        }
    }

    private async handleSetLastDiskImageOSWORDResult(handler: Handler, p: Buffer): Promise<void> {
        if (this.diskImageFlow === undefined) {
            return errors.generic(`No disk image flow`);
        }

        this.diskImageFlow.setLastOSWORDResult(p);
    }

    private async handleFinishDiskImageFlow(handler: Handler, p: Buffer): Promise<Response> {
        if (this.diskImageFlow === undefined) {
            return errors.generic(`No disk image flow`);
        }

        const finish = await this.diskImageFlow.finish();

        const builder = new utils.BufferBuilder(this.diskImageFlow.getBufferAddress());

        builder.writeUInt8(finish.fs);
        const selectCommandOffset = builder.writeUInt32LE(0);
        const postSelectCommandOffset = builder.writeUInt32LE(0);

        builder.setUInt32LE(builder.getNextAddress(), selectCommandOffset);
        builder.writeBuffer(encodeForOSCLI(finish.fsStarCommand));

        builder.setUInt32LE(builder.getNextAddress(), postSelectCommandOffset);
        builder.writeBuffer(encodeForOSCLI(finish.starCommand));

        this.diskImageFlow = undefined;

        return newResponse(beeblink.RESPONSE_DATA, builder.createBuffer());
    }

    private async handleWrapped(handler: Handler, p: Buffer): Promise<Response> {
        this.payloadMustBeAtLeast(handler, p, 5);

        const maxResponsePayloadSize = p.readUInt32LE(1);

        const request = new Request(p[0], p.subarray(5));

        let response = await this.handleRequest(request);

        if (request.isFireAndForget()) {
            // Sneak in and replace the response.
            response = new Request(0, Buffer.alloc(0));
        }

        const wrappedSize = Math.min(response.p.length, maxResponsePayloadSize);
        const wrappedResponsePayload = Buffer.alloc(5 + wrappedSize);
        wrappedResponsePayload.writeUInt8(response.c, 0);
        wrappedResponsePayload.writeUInt32LE(response.p.length, 1);
        response.p.copy(wrappedResponsePayload, 5);

        return new Response(beeblink.RESPONSE_DATA, wrappedResponsePayload);
    }

    private async handleReadDiskImage(handler: Handler, p: Buffer): Promise<Response> {
        const details = this.getDiskImageFlowDetailsFromRequestPayload(p);

        const flow = await this.createDiskImageReadFlow(details);

        return await this.startDiskImageFlow(flow, details.bufferAddress, details.bufferSize);
    }

    private async handleWriteDiskImage(handler: Handler, p: Buffer): Promise<Response> {
        const details = this.getDiskImageFlowDetailsFromRequestPayload(p);

        const flow = await this.createDiskImageWriteFlow(details);

        return await this.startDiskImageFlow(flow, details.bufferAddress, details.bufferSize);
    }

    private internalError(text: string): never {
        return errors.generic(text);
    }

    private payloadMustBeAtLeast(handler: Handler, p: Buffer, minSize: number) {
        if (p.length < minSize) {
            const message = 'Bad ' + handler.name + ' request';
            this.log?.pn('Payload length = ' + p.length + ', but must be at least ' + minSize + ': ' + message);
            this.internalError(message);
        }
    }

    private payloadMustBe(handler: Handler, p: Buffer, size: number) {
        if (p.length !== size) {
            const message = 'Bad ' + handler.name + ' request';
            this.log?.pn('Payload length = ' + p.length + ', but must be ' + size + ': ' + message);
            this.internalError(message);
        }
    }

    private async filesInfoResponse(afsp: beebfs.FQN): Promise<string> {
        const files = await this.bfs.findFilesMatching(afsp);

        if (files.length === 0) {
            return errors.fileNotFound();
        }

        let text = '';

        for (const file of files) {
            text += `${await this.bfs.getInfoText(file)}${BNL}`;
        }

        return text;
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

    private prepareForTextResponse(value: string | Buffer): void {
        if (typeof value === 'string') {
            value = Buffer.from(value, 'binary');
        }

        this.stringBuffer = value;
        this.stringBufferIdx = 0;

        // ...args: (number | string)[]) {
        // this.setString(...args);

        // return newResponse(beeblink.RESPONSE_TEXT, 0);
    }

    private initCommandLine(commandLineString: string): CommandLine {
        let commandLine: CommandLine;

        this.log?.pn('command line=' + JSON.stringify(commandLineString));
        try {
            commandLine = new CommandLine(commandLineString);
        } catch (error) {
            if (error instanceof errors.BeebError) {
                this.log?.pn('parse error: ' + error.toString());
            }

            throw error;
        }

        this.log?.pn(commandLine.parts.length + ' part(s), Y=' + utils.hexdec(commandLine.getY()));
        for (let i = 0; i < commandLine.parts.length; ++i) {
            this.log?.pn('[' + i + ']: ' + JSON.stringify(commandLine.parts[i]));
        }

        return commandLine;
    }

    private async handleRun(commandLine: CommandLine, tryLibDir: boolean): Promise<Response> {
        if (commandLine.parts.length === 0) {
            return errors.badName();
        }

        this.log?.pn('*RUN: ``' + commandLine.parts[0] + '\'\' (try lib dir: ' + tryLibDir + ')');

        const fsp = await this.bfs.parseFileString(commandLine.parts[0]);
        const file = await this.bfs.getFileForRUN(fsp, tryLibDir);

        if (file.load === beebfs.SHOULDNT_LOAD || file.exec === beebfs.SHOULDNT_EXEC) {
            return errors.wont();
        }

        const data = await beebfs.FS.readFile(file);

        const builder = new utils.BufferBuilder();

        builder.writeUInt8(commandLine.getY());
        builder.writeUInt32LE(file.load);
        builder.writeUInt32LE(file.exec);
        builder.writeBuffer(data);

        return newResponse(beeblink.RESPONSE_RUN, builder);
    }

    private async volsCommand(commandLine: CommandLine): Promise<string> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : '*';

        const volumes = await this.bfs.findAllVolumesMatching(arg);

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

        return text;
    }

    private async hstatusCommand(commandLine: CommandLine): Promise<string> {
        let text = '';

        const begin = (title: string) => {
            if (text.length > 0) {
                text += BNL;
            }

            text += `${title}:${BNL}${BNL}`;
        };

        const status = () => {
            begin(`Status`);

            try {
                text += this.getVolumeInfoString(this.bfs.getVolume());
                text += this.bfs.getDefaultsString();
            } catch (error) {
                // getVolume throws if no volume, and this is the 1% of times
                // where that's a bit annoying.
                text += `${error}${BNL}`;
            }
        };

        const files = () => {
            begin(`Open files`);
            text += this.bfs.getOpenFilesOutput();
        };

        const drives = async () => {
            begin(`Drives`);
            text += await this.bfs.getDrivesOutput();
        };

        if (commandLine.parts.length >= 2) {
            for (const char of commandLine.parts[1].toLowerCase()) {
                switch (char) {
                    case 'h': status(); break;
                    case 'f': files(); break;
                    case 'd': await drives(); break;
                    default: return errors.syntax();
                }
            }
        } else {
            status();
            files();
            await drives();
        }

        return text;
    }

    private async infoCommand(commandLine: CommandLine): Promise<string> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const fqn = await this.bfs.parseFileString(commandLine.parts[1]);
        return await this.filesInfoResponse(fqn);
    }

    private async winfoCommand(commandLine: CommandLine): Promise<string> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const afsp = await this.bfs.parseFileString(commandLine.parts[1]);
        const files = await this.bfs.findFilesMatching(afsp);

        if (files.length === 0) {
            return errors.fileNotFound();
        }

        let text = '';

        for (const file of files) {
            text += `${await this.bfs.getWideInfoText(file)}${BNL}`;
        }

        return text;
    }

    private async accessCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        let attrString = '';
        if (commandLine.parts.length >= 3) {
            attrString = commandLine.parts[2];
        }

        const fqn = await this.bfs.parseFileString(commandLine.parts[1]);
        const beebFiles = await this.bfs.findFilesMatching(fqn);
        for (const beebFile of beebFiles) {
            // the validity of `attrString' will be checked over and over again,
            // which is kind of stupid.
            const newFile = this.bfs.getFileWithModifiedAttributes(beebFile, attrString);

            await this.bfs.writeBeebFileMetadata(newFile);
        }
    }

    private async deleteCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const fqn = await this.bfs.parseFileString(commandLine.parts[1]);

        await this.bfs.delete(fqn);
    }

    private async dirCommand(commandLine: CommandLine): Promise<void> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : undefined;
        await this.bfs.starDir(arg);
    }

    private async driveCommand(commandLine: CommandLine): Promise<void> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : undefined;
        await this.bfs.starDrive(arg);
    }

    private async libCommand(commandLine: CommandLine): Promise<void> {
        const arg = commandLine.parts.length >= 2 ? commandLine.parts[1] : undefined;
        await this.bfs.starLib(arg);
    }

    private async typeCommand(commandLine: CommandLine): Promise<string> {
        if (commandLine.parts.length !== 2) {
            return errors.syntax();
        }

        const lines = await this.bfs.readTextFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFileString(commandLine.parts[1])));

        return lines.join(BNL) + BNL;
    }

    private async listCommand(commandLine: CommandLine): Promise<string> {
        if (commandLine.parts.length !== 2) {
            return errors.syntax();
        }

        const lines = await this.bfs.readTextFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFileString(commandLine.parts[1])));

        let text = '';

        for (let i = 0; i < lines.length; ++i) {
            text += ((i + 1) % 10000).toString().padStart(4, ' ') + ' ' + lines[i] + BNL;
        }

        return text;
    }

    private async locateCommand(commandLine: CommandLine): Promise<string> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        let format: string;
        if (commandLine.parts.length >= 3) {
            format = commandLine.parts[2];
            if (format === '') {
                return errors.syntax();
            }
        } else {
            format = 'n';
        }

        const foundFiles: beebfs.File[] = await this.bfs.starLocate(commandLine.parts[1]);

        format = format.toLowerCase();

        let text = '';
        if (foundFiles.length === 0) {
            text += 'No files found.' + utils.BNL;
        } else {
            const foundFileFQNStrings = [];
            let maxFQNLength = 0;
            if (format.indexOf('n') >= 0) {
                for (const foundFile of foundFiles) {
                    const fqnString = foundFile.fqn.toString();
                    foundFileFQNStrings.push(fqnString);
                    maxFQNLength = Math.max(maxFQNLength, fqnString.length);
                }
            }

            const foundFileHashes = [];
            let foundFileHashWidth = 0;
            if (format.indexOf('h') >= 0) {
                for (const foundFile of foundFiles) {
                    const data = await beebfs.FS.readFile(foundFile);
                    const hasher = crypto.createHash('sha1');
                    hasher.update(data);
                    const hash = hasher.digest('hex');
                    foundFileHashes.push(hash);
                }

                // count number of uniques in total.
                let set = new Set();
                for (const foundFileHash of foundFileHashes) {
                    set.add(foundFileHash);
                }

                const numUniqueHashes = set.size;

                foundFileHashWidth = 1;
                for (; ;) {
                    set = new Set();
                    for (const foundFileHash of foundFileHashes) {
                        set.add(foundFileHash.substring(0, foundFileHashWidth));
                    }

                    if (set.size === numUniqueHashes) {
                        break;
                    }

                    // and eventually, the max width will be reached
                    // automatically.
                    ++foundFileHashWidth;
                }
            }

            let needStat = false;
            if (format.indexOf('s') >= 0 || format.indexOf('c') >= 0 || format.indexOf('m') >= 0) {
                needStat = true;
            }

            const lines = [];
            for (let foundFileIdx = 0; foundFileIdx < foundFiles.length; ++foundFileIdx) {
                const foundFile = foundFiles[foundFileIdx];

                let line = '';

                let stats: fs.Stats | undefined;
                if (needStat) {
                    stats = await this.bfs.tryGetFileStats(foundFile);
                }

                for (const c of format) {
                    switch (c) {
                        case 'n':
                            line += ` ${foundFileFQNStrings[foundFileIdx].padEnd(maxFQNLength)}`;
                            break;

                        case 'a':
                            line += ` ${this.bfs.getAttrString(foundFile)}`;
                            break;

                        case 'l':
                            line += ` ${utils.hex8(foundFile.load).toUpperCase()}`;
                            break;

                        case 'e':
                            line += ` ${utils.hex8(foundFile.exec).toUpperCase()}`;
                            break;

                        case 's':
                            if (stats === undefined) {
                                line += ` (s?)`;
                            } else {
                                line += ` ${utils.hex8(stats.size).toUpperCase()}`;
                            }
                            break;

                        case 'h':
                            line += ` ${foundFileHashes[foundFileIdx].substring(0, foundFileHashWidth)}`;
                            break;

                        case 'c':
                            if (stats === undefined) {
                                line += ` (c?)`;
                            } else {
                                line += ` ${utils.getDateString(stats.ctime)}`;
                            }
                            break;

                        case 'm':
                            if (stats === undefined) {
                                line += ` (m?)`;
                            } else {
                                line += ` ${utils.getDateString(stats.mtime)}`;
                            }
                            break;

                        default:
                            return errors.syntax();
                    }
                }

                lines.push(line.trim());
            }

            lines.sort();

            for (const line of lines) {
                text += `${line}${utils.BNL}`;
            }
        }

        return text;
    }

    private async dumpCommand(commandLine: CommandLine): Promise<string> {
        return await this.dumpCommandInternal(commandLine, false);
    }

    private async wdumpCommand(commandLine: CommandLine): Promise<string> {
        return await this.dumpCommandInternal(commandLine, true);
    }

    private async dumpCommandInternal(commandLine: CommandLine, wide: boolean): Promise<string> {
        if (commandLine.parts.length !== 2) {
            return errors.syntax();
        }

        const data = await beebfs.FS.readFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFileString(commandLine.parts[1])));

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

        return text;
    }

    private async renameCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 3) {
            return errors.syntax();
        }

        const oldFQN = await this.bfs.parseFileString(commandLine.parts[1]);
        const newFQN = await this.bfs.parseFileString(commandLine.parts[2]);

        await this.bfs.rename(oldFQN, newFQN);
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

        const rom = await beebfs.FS.readFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFileString(commandLine.parts[1])));

        this.log?.pn(`Addr: 0x${utils.hex4(addr)}, bank: 0x${utils.hex2(addr)}, size: 0x${utils.hex4(rom.length)}`);

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

    private async titleCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        await this.bfs.setTitle(commandLine.parts[1]);
    }

    private async volbrowserCommand(commandLine: CommandLine): Promise<Response> {
        return newResponse(beeblink.RESPONSE_SPECIAL, beeblink.RESPONSE_SPECIAL_VOLUME_BROWSER);
    }

    private getVolumeInfoString(volume: beebfs.Volume): string {
        let str = '';

        str += `Volume name: ${volume.name}${BNL}`;
        str += `Volume path: ${volume.path}${BNL}`;
        str += `Volume type: ${volume.type.name}${BNL}`;

        return str;
    }

    private async newvolCommand(commandLine: CommandLine): Promise<string> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const volume = await this.bfs.createVolume(commandLine.parts[1]);

        await this.bfs.mount(volume);

        return this.getVolumeInfoString(volume);
    }

    private async volCommand(commandLine: CommandLine): Promise<string> {
        let volume: beebfs.Volume;
        if (commandLine.parts.length >= 2) {
            const volumes = await this.bfs.findFirstVolumeMatching(commandLine.parts[1]);
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

        return this.getVolumeInfoString(volume);
    }

    private getDiskImageFlowDetailsFromRequestPayload(p: Buffer): IDiskImageFlowDetails {
        this.log?.pn(`getDiskImageFlowDetailsFromRequestPayload`);

        const reader = new utils.BufferReader(p);

        const bufferAddress = reader.readUInt32LE();
        const bufferSize = reader.readUInt32LE();
        const typeStr = reader.readString(13);
        const driveStr = reader.readString(13);
        const readAllSectors = reader.readUInt8() !== 0;
        const fileName = reader.readString(13);

        let type: DiskImageType;
        if (typeStr === 'adfs') {
            type = DiskImageType.ADFS;
        } else if (typeStr === 'ssd') {
            type = DiskImageType.SSD;
        } else if (typeStr === 'dsd') {
            type = DiskImageType.DSD;
        } else if (typeStr === 'sdd_ddos') {
            type = DiskImageType.SDD_DDOS;
        } else if (typeStr === 'ddd_ddos') {
            type = DiskImageType.DDD_DDOS;
        } else {
            return errors.generic('Unknown disk type');
        }

        this.log?.pn(`Got disk image flow details from payload: `);
        this.log?.withIndent('    ', () => {
            this.log!.pn(`Buffer address: 0x${utils.hex8(bufferAddress)} `);
            this.log!.pn(`Buffer size: ${bufferSize} (0x${utils.hex8(bufferSize)})`);
            this.log!.pn(`Drive: "${driveStr}"`);
            this.log!.pn(`Type: ${type} ("${typeStr}")`);
            this.log!.pn(`Read all sectors: ${readAllSectors} `);
            this.log!.pn(`File name: "${fileName}"`);
        });

        return {
            bufferAddress,
            bufferSize,
            fileName,
            drive: +driveStr,
            type,
            readAllSectors
        };
    }

    private checkDiskImageDSDDrive(details: IDiskImageFlowDetails): void {
        if (details.drive !== 0 && details.drive !== 1) {
            return errors.badDrive();
        }
    }

    private checkDiskImageADFSDrive(details: IDiskImageFlowDetails): void {
        // there's only a 3-bit field for ADFS drives.
        if (details.drive < 0 || details.drive > 7) {
            return errors.badDrive();
        }
    }

    private async createDiskImageReadFlow(details: IDiskImageFlowDetails): Promise<diskimage.Flow> {
        const file = await this.bfs.getBeebFileForWrite(await this.bfs.parseFileString(details.fileName));

        switch (details.type) {
            case DiskImageType.ADFS:
                this.checkDiskImageADFSDrive(details);
                return new adfsimage.ReadFlow(details.drive, details.readAllSectors, file, this.log);

            case DiskImageType.SSD:
                return new dfsimage.ReadFlow(details.drive, false, details.readAllSectors, file, this.log);

            case DiskImageType.DSD:
                this.checkDiskImageDSDDrive(details);
                return new dfsimage.ReadFlow(details.drive, true, details.readAllSectors, file, this.log);

            case DiskImageType.SDD_DDOS:
                return new ddosimage.ReadFlow(details.drive, false, file, this.log);

            case DiskImageType.DDD_DDOS:
                return new ddosimage.ReadFlow(details.drive, true, file, this.log);

            default:
                return errors.generic(`Unsupported type`);
        }
    }

    private async createDiskImageWriteFlow(details: IDiskImageFlowDetails): Promise<diskimage.Flow> {
        const data = await beebfs.FS.readFile(await this.bfs.getExistingBeebFileForRead(await this.bfs.parseFileString(details.fileName)));

        switch (details.type) {
            case DiskImageType.ADFS:
                this.checkDiskImageADFSDrive(details);
                return new adfsimage.WriteFlow(details.drive, details.readAllSectors, data, this.log);

            case DiskImageType.SSD:
                return new dfsimage.WriteFlow(details.drive, false, details.readAllSectors, data, this.log);

            case DiskImageType.DSD:
                this.checkDiskImageDSDDrive(details);
                return new dfsimage.WriteFlow(details.drive, true, details.readAllSectors, data, this.log);

            case DiskImageType.SDD_DDOS:
                return new ddosimage.WriteFlow(details.drive, false, data, this.log);

            case DiskImageType.DDD_DDOS:
                return new ddosimage.WriteFlow(details.drive, true, data, this.log);

            default:
                return errors.generic(`Unsupported type`);
        }
    }

    private async defaultsCommand(commandLine: CommandLine): Promise<string> {
        const modeLC = commandLine.parts.length >= 2 ? commandLine.parts[1].toLowerCase() : undefined;

        if (modeLC === undefined || modeLC === 's') {
            this.bfs.setDefaults();
        } else if (modeLC === 'r') {
            this.bfs.resetDefaults();
        } else {
            return errors.syntax();
        }

        return this.bfs.getDefaultsString();
    }
}
