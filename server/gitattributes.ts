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

// Manipulate .gitattributes file(s). Don't have multiple BeebFS objects
// potentially writing to the same .gitattributes file!

import * as path from 'path';
import * as utils from './utils';

class Change {
    private filePath: string;
    private remove: string | undefined;
    private add: string | undefined;
    private log: utils.Log;
    private extraVerbose: boolean;

    public constructor(filePath: string, remove: string | undefined, add: string | undefined, log: utils.Log) {
        this.filePath = filePath;
        this.remove = remove;
        this.add = add;
        this.log = log;
        this.extraVerbose = false;
    }

    public async do(): Promise<void> {
        if (this.extraVerbose) {
            this.log.p('Change.do: filePath=``' + this.filePath + '\'\': ');

            if (this.remove !== undefined) {
                this.log.p(' remove ``' + this.remove + '\'\'');
            }

            if (this.add !== undefined) {
                this.log.p(' add ``' + this.add + '\'\'');
            }

            this.log.p('\n');
        }

        const gaPath = path.join(path.dirname(this.filePath), '.gitattributes');
        const basename = path.basename(this.filePath);

        let gaData = await utils.tryReadFile(gaPath);
        if (gaData === undefined) {
            if (this.add === undefined) {
                // it's ok, nothing to do.
                return;
            }

            gaData = Buffer.alloc(0);
        }

        const gaLines = utils.splitTextFileLines(gaData, 'utf-8');

        const spacesRE = new RegExp('\\s+');

        let added = false;
        let removed = false;
        let fileChanged = false;

        let lineIdx = 0;

        while (lineIdx < gaLines.length) {
            const parts = gaLines[lineIdx].split(spacesRE);

            let lineChanged = false;

            if (parts.length >= 1) {
                if (parts[0] === basename) {
                    if (this.remove !== undefined) {
                        let i = 1;
                        while (i < parts.length) {
                            if (parts[i] === this.remove) {
                                parts.splice(i, 1);
                                lineChanged = true;
                                removed = true;
                            } else {
                                ++i;
                            }
                        }
                    }

                    if (this.add !== undefined) {
                        let found = false;
                        for (let i = 1; i < parts.length; ++i) {
                            if (parts[i] === this.add) {
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            parts.push(this.add);
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

        if (this.add !== undefined) {
            if (!added) {
                gaLines.push(basename + ' ' + this.add);
                added = true;
                fileChanged = true;
            }
        }

        if (gaLines.length === 0) {
            this.log.pn('Deleting: ' + gaPath);
            try {
                await utils.forceFsUnlink(gaPath);
            } catch (error) {
                this.log.pn('Failed to delete ``' + gaPath + '\'\': ' + error);
            }
        } else if (fileChanged) {
            this.log.pn('Updating: ' + gaPath);

            if (this.remove !== undefined) {
                this.log.pn('    (Removing: ' + basename + ' ' + this.remove + ')');
            }

            if (this.add !== undefined && added) {
                this.log.pn('    (Adding: ' + basename + ' ' + this.add + ')');
            }

            try {
                const gaNewData = Buffer.from(gaLines.join('\n'), 'utf-8') + '\n';
                await utils.fsWriteFile(gaPath, gaNewData);
            } catch (error) {
                this.log.pn('Failed to write to ``' + gaPath + '\'\': ' + error);
            }
        }
    }
}

export class Manipulator {
    private queue: Change[];
    private log: utils.Log;

    public constructor(verbose: boolean) {
        this.queue = [];
        this.log = new utils.Log('.gitattributes', process.stderr);
        this.log.enabled = verbose;
    }

    public start(): void {
        //
    }

    public makeFolderNotText(folderPath: string): void {
        this.change(path.join(folderPath, '*'), undefined, '-text');
    }

    public makeFileBASIC(filePath: string): void {
        this.change(filePath, undefined, 'diff=bbcbasic');
    }

    public makeFileNotBASIC(filePath: string): void {
        this.change(filePath, 'diff=bbcbasic', undefined);
    }

    private change(filePath: string, remove: string | undefined, add: string | undefined): void {
        this.queue.push(new Change(filePath, remove, add, this.log));

        if (this.queue.length === 1) {
            // The queue was previously empty, so set it going again.
            this.run();
        } else {
            // There's at least one operation ongoing, so there'll be another
            // call to this.run soon enough.
        }
    }

    private run(): void {
        const change = this.queue.shift();
        if (change !== undefined) {
            change.do().then(() => {
                this.run();
            }).catch((error) => {
                this.log.pn('Error: ' + error);

                // And carry on regardless...
                this.run();
            });
        }
    }
}
