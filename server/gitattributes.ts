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

// Manipulate .gitattributes file(s). Don't have multiple BeebFS objects
// potentially writing to the same .gitattributes file!

import * as path from 'path';
import * as utils from './utils';
import * as beebfs from './beebfs';

export class Manipulator {
    private queue: (() => Promise<void>)[];
    private log: utils.Log | undefined;
    private extraVerbose: boolean = false;
    private quiescentCallbacks: (() => void)[];

    public constructor(verbose: boolean) {
        this.queue = [];
        this.log = utils.Log.create('.gitattributes', process.stderr, verbose);
        this.quiescentCallbacks = [];
    }

    public start(): void {
        //
    }

    public whenQuiescent(callback: () => void): void {
        this.quiescentCallbacks.push(callback);
    }

    // Mark files in given volume as -text.
    public makeVolumeNotText(volume: beebfs.Volume): void {
        if (volume.isReadOnly()) {
            return;
        }

        this.change(path.join(volume.path, '*'), undefined, '-text');
    }

    public deleteFile(filePath: string): void {
        // TODO - actually write this.
    }

    public renameFile(oldFilePath: string, newFilePath: string): void {
        // TODO - actually write this.
    }

    public makeFileBASIC(filePath: string, basic: boolean): void {
        const diff = 'diff=bbcbasic';

        if (basic) {
            this.change(filePath, undefined, diff);
        } else {
            this.change(filePath, diff, undefined);
        }
    }

    public scanForBASIC(volume: beebfs.Volume): void {
        if (volume.isReadOnly()) {
            return;
        }

        this.push(async (): Promise<void> => {
            const beebFiles = await volume.type.findBeebFilesInVolume(volume, undefined);

            //this.log?.pn(path.join(drive.volumePath, drive.name) + ': ' + beebFiles.length + ' Beeb file(s)\n');

            for (const beebFile of beebFiles) {
                const data = await utils.tryReadFile(beebFile.hostPath);
                if (data === undefined) {
                    continue;
                }

                const isBASIC = utils.isBASIC(data);

                //this.log?.pn(beebFile.hostPath + ': is BASIC: ' + (isBASIC ? 'yes' : 'no'));

                this.makeFileBASIC(beebFile.hostPath, isBASIC);
            }
        });
    }

    private change(filePath: string, remove: string | undefined, add: string | undefined): void {
        this.push(async (): Promise<void> => {
            if (this.extraVerbose) {
                this.log?.p('change: filePath=``' + filePath + '\'\': ');

                if (remove !== undefined) {
                    this.log?.p(' remove ``' + remove + '\'\'');
                }

                if (add !== undefined) {
                    this.log?.p(' add ``' + add + '\'\'');
                }

                this.log?.p('\n');
            }

            const gaPath = path.join(path.dirname(filePath), '.gitattributes');

            let basename = path.basename(filePath);

            if (basename.length === 0) {
                this.log?.pn('(basename.length === 0)');
                return;
            }

            // https://git-scm.com/docs/gitignore
            if (basename[0] === '#' || basename[0] === '!') {
                basename = '\\' + basename;
            }

            let gaData = await utils.tryReadFile(gaPath);
            if (gaData === undefined) {
                if (add === undefined) {
                    // it's ok, nothing to do.
                    this.log?.pn('(nothing to do)');
                    return;
                }

                gaData = Buffer.alloc(0);
            }

            const gaLines = utils.splitTextFileLines(gaData, 'utf-8');

            const spacesRE = new RegExp('\\s+');

            let added = false;
            let removed = false;// tslint:disable-line no-unused-variable
            let fileChanged = false;

            let lineIdx = 0;

            while (lineIdx < gaLines.length) {
                const parts = gaLines[lineIdx].split(spacesRE);

                let lineChanged = false;

                if (parts.length >= 1) {
                    if (parts[0] === basename) {
                        if (remove !== undefined) {
                            let i = 1;
                            while (i < parts.length) {
                                if (parts[i] === remove) {
                                    parts.splice(i, 1);
                                    lineChanged = true;
                                    removed = true;
                                } else {
                                    ++i;
                                }
                            }
                        }

                        if (add !== undefined) {
                            let found = false;
                            for (let i = 1; i < parts.length; ++i) {
                                if (parts[i] === add) {
                                    found = true;
                                    break;
                                }
                            }

                            if (!found) {
                                parts.push(add);
                                lineChanged = true;
                            }

                            added = true;
                        }
                    }
                }

                if (lineChanged) {
                    fileChanged = true;

                    if (parts.length === 1) {
                        // can remove this line now.
                        gaLines.splice(lineIdx, 1);
                    } else {
                        // replace this line.
                        gaLines[lineIdx] = parts.join(' ');
                        ++lineIdx;
                    }
                } else {
                    ++lineIdx;
                }
            }

            if (add !== undefined) {
                if (!added) {
                    gaLines.push(basename + ' ' + add);
                    added = true;
                    fileChanged = true;
                }
            }

            if (gaLines.length === 0) {
                this.log?.pn('Deleting: ' + gaPath);
                try {
                    await utils.forceFsUnlink(gaPath);
                } catch (error) {
                    this.log?.pn('Failed to delete ``' + gaPath + '\'\': ' + error);
                }
            } else if (fileChanged) {
                this.log?.pn('Updating: ' + gaPath);

                if (remove !== undefined) {
                    this.log?.pn('    (Removing: ' + basename + ' ' + remove + ')');
                }

                if (add !== undefined && added) {
                    this.log?.pn('    (Adding: ' + basename + ' ' + add + ')');
                }

                try {
                    const gaNewData = Buffer.from(gaLines.join('\n'), 'utf-8') + '\n';
                    await utils.fsWriteFile(gaPath, gaNewData);
                } catch (error) {
                    this.log?.pn('Failed to write to ``' + gaPath + '\'\': ' + error);
                }
            }
        });
    }

    private push(fun: () => Promise<void>): void {
        this.queue.push(fun);

        if (this.queue.length === 1) {
            // The queue was previously empty, so set it going again.
            this.run();
        } else {
            // There's at least one operation ongoing, so there'll be another
            // call to this.run soon enough.
        }
    }

    private run(): void {
        if (this.queue.length > 0) {
            this.queue[0]().then(() => {
                this.next();
            }).catch((error) => {
                this.log?.pn('Error: ' + error);
                this.next();
            });
        } else {
            for (const callback of this.quiescentCallbacks) {
                callback();
            }

            this.quiescentCallbacks = [];
        }
    }

    private next(): void {
        this.queue.shift();
        this.run();
    }
}
