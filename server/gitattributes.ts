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
    private extraVerbose = false;
    private quiescentCallbacks: (() => void)[];

    public constructor(verbose: boolean, extraVerbose: boolean) {
        this.queue = [];
        this.log = utils.Log.create('.gitattributes', process.stderr, verbose);
        this.quiescentCallbacks = [];
        this.extraVerbose = extraVerbose;
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

        this.change(path.join(volume.path, '*'), undefined, undefined, ['-text']);
    }

    public deleteFile(filePath: string): void {
        this.change(filePath, undefined, undefined, undefined);
    }

    public renameFile(oldFilePath: string, newFilePath: string): void {
        this.change(oldFilePath, newFilePath, undefined, undefined);
    }

    public makeFileBASIC(filePath: string, basic: boolean): void {
        const diff = 'diff=bbcbasic';

        if (basic) {
            this.change(filePath, undefined, undefined, [diff]);
        } else {
            this.change(filePath, undefined, diff, undefined);
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
                const data = await utils.tryReadFile(beebFile.serverPath);
                if (data === undefined) {
                    continue;
                }

                const isBASIC = utils.isBASIC(data);

                //this.log?.pn(beebFile.hostPath + ': is BASIC: ' + (isBASIC ? 'yes' : 'no'));

                this.makeFileBASIC(beebFile.serverPath, isBASIC);
            }
        });
    }

    private getGitattributesBasename(filePath: string): string {
        let basename = path.basename(filePath);
        if (basename.length > 0) {
            // https://git-scm.com/docs/gitignore
            if (basename[0] === '#' || basename[0] === '!') {
                basename = '\\' + basename;
            }
        }
        return basename;
    }

    // The all-in-one gitattributes modification function.
    //
    // Finds entry for filePath, if any.
    //
    // If newFilePath===undefined, set the entry's name to newFilePath.
    //
    // If add!==undefined, add that as flags to the entry; if
    // remove!==undefined, removes any matching flags from the entry; if
    // add===undefined&&remove===undefined, remove all flags from the entry.
    //
    // If the entry has flags after all that, ensure it's present in
    // .gitattributes by adding or updating the existing entry; if none, ensure
    // it's not present, by removing if originally present.
    private change(filePath: string, newFilePath: string | undefined, remove: string | undefined, add: string[] | undefined): void {
        this.push(async (): Promise<void> => {
            if (this.extraVerbose) {
                this.log?.p('change: filePath=``' + filePath + '\'\': ');

                if (newFilePath !== undefined) {
                    this.log?.p(` newFilePath: \`\`${newFilePath}''`);
                }

                if (remove !== undefined) {
                    this.log?.p(' remove ``' + remove + '\'\'');
                }

                if (add !== undefined) {
                    this.log?.p(' add ``' + add + '\'\'');
                }

                this.log?.p('\n');
            }

            const gaPath = path.join(path.dirname(filePath), '.gitattributes');

            const basename = this.getGitattributesBasename(filePath);

            let gaData = await utils.tryReadFile(gaPath);
            if (gaData === undefined) {
                if (add === undefined) {
                    // it's ok, nothing to do.
                    //this.log?.pn(`nothing to do for: ${filePath}`);
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
                let parts = gaLines[lineIdx].split(spacesRE);

                let lineChanged = false;

                if (parts.length >= 1) {
                    if (parts[0] === basename) {
                        if (add === undefined && remove === undefined) {
                            // Delete or rename.
                            if (newFilePath !== undefined) {
                                // Queue up the rename for later.
                                this.change(newFilePath, undefined, undefined, parts.slice(1));
                            }

                            // Either way, remove the current entry.
                            parts = [];
                            lineChanged = true;
                            removed = true;
                        } else {
                            if (remove !== undefined) {
                                let i = 1;
                                while (i < parts.length) {
                                    if (parts[i] === remove) {
                                        parts.splice(i, 1);
                                        lineChanged = true;
                                        removed = true;// eslint-disable-line @typescript-eslint/no-unused-vars
                                    } else {
                                        ++i;
                                    }
                                }
                            }

                            if (add !== undefined) {
                                for (const newPart of add) {
                                    if (parts.indexOf(newPart, 1) < 0) {
                                        parts.push(newPart);
                                        lineChanged = true;
                                    }
                                }

                                added = true;
                            }
                        }
                    }
                }

                if (lineChanged) {
                    fileChanged = true;

                    if (parts.length <= 1) {
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
                    gaLines.push(basename + ' ' + add.join(' '));
                    added = true;
                    fileChanged = true;
                }
            }

            // If renaming, and no entry for the original file was found,
            // there's no need to do anything. The new file doesn't need an
            // entry either.

            if (fileChanged) {
                this.log?.pn(`Updating: ${gaPath}`);

                if ((remove !== undefined || add === undefined) && removed) {
                    this.log?.pn(`    (Removing: ${basename}${remove === undefined ? '' : ' ' + remove})`);
                }

                if (add !== undefined && added) {
                    this.log?.pn(`    (Adding: ${basename} ${add})`);
                }

                // The file could be empty. But that's OK! The code will only
                // get here if it was previously non-empty.

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
