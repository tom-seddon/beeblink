//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
// Copyright (C) 2018, 2019, 2020 Tom Seddon
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
// details.
//
// You should have received a copy of the GNU General Public License along with
// this program. If not, see <https://www.gnu.org/licenses/>.
//
//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

import * as utils from './utils';
import * as beebfs from './beebfs';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Column {
    public rows: beebfs.Volume[] = [];
    public width: number = 0;
    public x: number = 0;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class Result {
    public readonly done: boolean;
    public readonly text: Buffer;
    public readonly volume: beebfs.Volume | undefined;
    public readonly boot: boolean;
    public readonly flushKeyboardBuffer: boolean;

    public constructor(done: boolean, text: Buffer, volume: beebfs.Volume | undefined, boot: boolean, flushKeyboardBuffer: boolean) {
        this.done = done;
        this.text = text;
        this.volume = volume;
        this.boot = boot;
        this.flushKeyboardBuffer = flushKeyboardBuffer;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

enum BrowserMode {
    Browse,
    EditFilter,
    ShowInfo,
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class Browser {
    private readonly teletext: boolean;
    private readonly width: number;
    private readonly height: number;
    private readonly offset: number;
    private normal: string;
    private highlight: string;
    private columns: Column[];
    private numFilteredVolumes: number;
    private volumes: beebfs.Volume[];
    private x: number;
    private rowIdx: number;
    private colIdx: number;
    private filter: string;
    private filterLCs: string[];
    private log: utils.Log | undefined;// tslint:disable-line no-unused-variable
    private mode: BrowserMode;
    private boxTL: string;
    private boxTR: string;
    private boxV: string;
    private boxH: string;
    private boxBL: string;
    private boxBR: string;
    private boxTitleL: string;
    private boxTitleR: string;

    // used when handling keypresses.
    private flushKeyboardBuffer!: boolean;
    private prints: utils.BufferBuilder;
    private done: boolean;
    private selectedVolume: beebfs.Volume | undefined;
    private boot: boolean;

    // used in filter edit mode
    private filterEditY: number;

    public constructor(charSizeBytes: number, width: number, height: number, m128: boolean, volumes: beebfs.Volume[]) {
        this.log = utils.Log.create('BROWSER', process.stderr, true);

        this.width = width;
        this.height = height;

        this.volumes = volumes;
        this.volumes.sort((a, b) => utils.stricmp(a.name, b.name));

        if (charSizeBytes === 32) {
            this.normal = this.createString(17, 128, 17, 7);
            this.highlight = this.createString(17, 129, 17, 7);
            this.offset = 0;
            this.teletext = false;
        } else if (charSizeBytes === 16) {
            this.normal = this.createString(17, 128, 17, 3);
            this.highlight = this.createString(17, 129, 17, 3);
            this.offset = 0;
            this.teletext = false;
        } else if (charSizeBytes === 8) {
            this.normal = this.createString(17, 128, 17, 1);
            this.highlight = this.createString(17, 129, 17, 0);
            this.offset = 0;
            this.teletext = false;
        } else {
            // The logic for applying these is not the same as in the bitmap
            // modes.
            this.highlight = this.createString(132, 157, 131);
            this.normal = this.createString(32, 135, 156);
            this.offset = 3;
            this.teletext = true;
        }

        if (this.teletext || !m128) {
            this.boxTL = '+';
            this.boxTR = '+';
            this.boxV = '|';
            this.boxH = '-';
            this.boxBL = '+';
            this.boxBR = '+';
            this.boxTitleL = '-';
            this.boxTitleR = '-';
        } else {
            this.boxTL = this.createString(163);
            this.boxTR = this.createString(165);
            this.boxV = this.createString(169);
            this.boxH = this.createString(166);
            this.boxBL = this.createString(170);
            this.boxBR = this.createString(172);
            this.boxTitleL = this.createString(164);
            this.boxTitleR = this.createString(162);
        }

        this.rowIdx = -1;
        this.colIdx = -1;

        this.x = 0;
        this.mode = BrowserMode.Browse;
        this.filter = '';
        this.filterLCs = [];

        this.columns = [];
        this.numFilteredVolumes = 0;
        this.updateColumns(undefined);

        this.prints = new utils.BufferBuilder();
        this.done = false;
        this.boot = false;

        this.filterEditY = -1;
    }

    public getInitialString(): Buffer {
        this.clearPrints();

        // Write at text cursor.
        this.prints.writeUInt8(4);

        // Restore default palette.
        this.prints.writeUInt8(20);

        // Hide cursor.
        this.prints.writeUInt8(23, 1, 0, 0, 0, 0, 0, 0, 0, 0);

        // Redraw everything.
        this.printBrowser();

        return this.createPrintsBuffer();
    }

    public handleKey(key: number, shift: boolean): Result {
        this.done = false;
        this.clearPrints();
        this.flushKeyboardBuffer = true;
        this.boot = false;

        // const builder = new utils.BufferBuilder();
        // let done = false;
        // let volume: string | undefined;
        // let flushKeyboardBuffer;


        if (this.mode === BrowserMode.Browse) {
            this.handleBrowserKey(key, shift);
        } else if (this.mode === BrowserMode.EditFilter) {
            this.handleEditFilterKey(key);
        } else if (this.mode === BrowserMode.ShowInfo) {
            this.handleShowInfoKey(key);
        }

        return new Result(this.done, this.createPrintsBuffer(), this.selectedVolume, this.boot, this.flushKeyboardBuffer);
    }

    private clearPrints(): void {
        if (this.prints.getLength() > 0) {
            this.prints = new utils.BufferBuilder();
        }
    }

    private createPrintsBuffer(): Buffer {
        const buffer = this.prints.createBuffer();

        this.clearPrints();

        return buffer;
    }

    private getSelectedVolume(): beebfs.Volume | undefined {
        if (this.colIdx >= 0 && this.colIdx < this.columns.length) {
            if (this.rowIdx >= 0 && this.rowIdx < this.columns[this.colIdx].rows.length) {
                return this.columns[this.colIdx].rows[this.rowIdx];
            }
        }

        return undefined;
    }

    private updateColumns(oldVolume: beebfs.Volume | undefined) {
        //this.log.pn(this.rowIdx + ' ' + this.colIdx + ' ' + this.columns.length);
        // let oldVolume: Volume | undefined;
        // if (this.rowIdx >= 0 && this.colIdx >= 0) {
        //     oldVolume = this.columns[this.colIdx].rows[this.rowIdx];
        // }

        this.numFilteredVolumes = 0;

        let newColumn: Column | undefined;
        let x = 0;
        this.columns = [];
        for (const volume of this.volumes) {
            const displayNameLC = volume.name.toLowerCase();

            let match = true;
            for (const filterLC of this.filterLCs) {
                if (displayNameLC.indexOf(filterLC) < 0) {
                    match = false;
                    break;
                }
            }

            if (match) {
                if (newColumn === undefined) {
                    newColumn = new Column();
                    this.columns.push(newColumn);
                    newColumn.x = x;
                }

                newColumn.width = Math.max(newColumn.width, volume.name.length + this.offset);

                newColumn.rows.push(volume);
                ++this.numFilteredVolumes;

                if (newColumn.rows.length === this.height - 1) {
                    x += newColumn.width + 1;
                    newColumn = undefined;
                }
            }
        }

        this.colIdx = -1;
        this.rowIdx = -1;

        if (oldVolume !== undefined) {
            let found = false;

            for (let colIdx = 0; colIdx < this.columns.length && !found; ++colIdx) {
                const column = this.columns[colIdx];

                for (let rowIdx = 0; rowIdx < column.rows.length; ++rowIdx) {
                    if (column.rows[rowIdx] === oldVolume) {
                        this.colIdx = colIdx;
                        this.rowIdx = rowIdx;
                        this.x = column.x;
                        found = true;
                        break;
                    }
                }
            }
        }

        if (this.colIdx < 0) {
            this.colIdx = 0;
            this.rowIdx = 0;
            this.x = 0;
        }
    }

    private handleBrowserKey(key: number, shift: boolean): void {
        if (key === 0x88) {
            this.printCursorMovement(-1, 0);
        } else if (key === 0x89) {
            this.printCursorMovement(1, 0);
        } else if (key === 0x8a) {
            this.printCursorMovement(0, 1);
        } else if (key === 0x8b) {
            this.printCursorMovement(0, -1);
        } else if (key === 13) {
            this.printFinish();
            this.selectedVolume = this.columns[this.colIdx].rows[this.rowIdx];
            this.boot = shift;
            this.done = true;
        } else if (key === 27) {
            if (this.filterLCs.length > 0) {
                this.filterLCs = [];
                this.updateColumns(this.getSelectedVolume());
                this.printBrowser();
            } else {
                this.printFinish();
                this.done = true;
            }
        } else if (key === 32) {
            this.printFullPath();
            this.mode = BrowserMode.ShowInfo;
        } else if (key >= 33 && key <= 126) {
            this.mode = BrowserMode.EditFilter;
            this.filter = String.fromCharCode(key);
            this.printFilterEditor();
            this.printFilter();
            this.flushKeyboardBuffer = false;
        }
    }

    private handleEditFilterKey(key: number): void {
        if (key >= 33 && key <= 126) {
            this.filter += String.fromCharCode(key);
            this.printFilter();
            this.flushKeyboardBuffer = false;
        } else if (key === 127) {
            if (this.filter.length === 1) {
                this.mode = BrowserMode.Browse;
                this.printBrowser();
            } else {
                this.filter = this.filter.substring(0, this.filter.length - 1);
                this.printFilter();
            }
        } else if (key === 27) {
            this.mode = BrowserMode.Browse;
            this.printBrowser();
        } else if (key === 13) {
            this.mode = BrowserMode.Browse;
            this.filterLCs.push(this.filter.toLowerCase());
            const selectedVolume = this.getSelectedVolume();
            this.updateColumns(selectedVolume);
            if (this.numFilteredVolumes === 0) {
                this.filterLCs.pop();
                this.updateColumns(selectedVolume);
                this.printBrowser();
                const y = this.printBox('Error', 1);
                this.printTAB(2, y);
                this.print('No matches');
                this.mode = BrowserMode.ShowInfo;
            } else {
                this.printBrowser();
            }
        }
    }

    private handleShowInfoKey(key: number): void {
        this.mode = BrowserMode.Browse;
        this.printBrowser();
    }

    private printBox(title: string, numInnerLines: number): number {
        const numTotalLines = 2 + 2 + numInnerLines;

        const x = 0;
        const y = (this.height - numTotalLines) / 2;

        this.printTAB(x, y);

        const blank = ''.padEnd(this.width, ' ');

        this.print(blank);

        const titleLength = Math.min(title.length, this.width - 6);
        this.print(' ' + this.boxTL + this.boxTitleL + title.substring(0, titleLength) + this.boxTitleR + ''.padEnd(this.width - 6 - titleLength, this.boxH) + this.boxTR + ' ');
        for (let i = 0; i < numInnerLines; ++i) {
            this.print(' ' + this.boxV + ''.padEnd(this.width - 4, ' ') + this.boxV + ' ');
        }
        this.print(' ' + this.boxBL + ''.padEnd(this.width - 4, this.boxH) + this.boxBR + ' ');
        this.print(blank);

        return y + 2;
    }

    private printFullPath() {
        const volumePath = this.columns[this.colIdx].rows[this.rowIdx].path;

        const width = this.width - 4;
        const lines = [];
        for (let i = 0; i < volumePath.length; i += width) {
            lines.push(volumePath.substring(i, i + width));
        }

        const y = this.printBox('Full path', lines.length);
        for (let i = 0; i < lines.length; ++i) {
            this.printTAB(2, y + i);
            this.print(lines[i]);
        }
    }

    private printFilterEditor(): void {
        this.filterEditY = this.printBox('Add filter', 1);
    }

    private printFilter(): void {
        const x = 2;

        const maxWidth = this.width - 4;

        let text = this.filter;
        let cursorX;
        if (text.length > maxWidth) {
            text = text.substring(text.length - maxWidth);
            cursorX = x + text.length;
        } else if (text.length < maxWidth) {
            cursorX = x + text.length;
            text = text.padEnd(maxWidth, ' ');
        } else {
            cursorX = x + text.length;
        }

        this.printCursorVisible(false);

        this.printTAB(x, this.filterEditY);
        this.print(text);

        this.printCursorVisible(true);
        this.printTAB(cursorX, this.filterEditY);
    }

    private printPath(colIdx: number, rowIdx: number, highlight: boolean | undefined): void {
        const column = this.columns[colIdx];

        let text = column.rows[rowIdx].name;

        let offset = 0;
        if (this.teletext) {
            if (highlight === undefined) {
                offset = this.offset;
            } else {
                if (highlight) {
                    text = this.highlight + text + this.normal;
                } else {
                    text = this.normal + text;
                }
            }
        }

        let x = column.x - this.x;
        if (x < 0) {
            text = text.substring(-x);
            x = 0;
        }

        if (x + offset + text.length > this.width) {
            text = text.substring(0, this.width - (x + this.offset));
        }

        if (text.length > 0) {
            if (this.teletext) {
                if (highlight !== undefined) {
                    this.printTAB(x, rowIdx);
                    this.print(text);
                } else {
                    this.printTAB(x + offset, rowIdx);
                    this.print(text);
                }
            } else {
                this.printTAB(x, rowIdx);

                if (highlight === true) {
                    this.print(this.highlight);
                }

                this.print(text);

                if (highlight === true) {
                    this.print(this.normal);
                }
            }
        }
    }

    private printCursorMovement(dcol: number, drow: number): void {
        const oldColIdx = this.colIdx;
        const oldRowIdx = this.rowIdx;

        let col = this.colIdx + dcol;
        if (col < 0 || col >= this.columns.length) {
            return undefined;
        }

        let row = this.rowIdx + drow;
        if (row < 0) {
            --col;
            if (col < 0) {
                return undefined;
            }

            row = this.columns[col].rows.length - 1;
        } else if (row >= this.columns[col].rows.length) {
            ++col;
            if (col >= this.columns.length) {
                return undefined;
            }

            row = 0;
        }

        this.colIdx = col;
        this.rowIdx = row;

        const column = this.columns[this.colIdx];
        if (column.x < this.x) {
            // need to redraw entire screen.
            this.x = column.x;
            this.printBrowser();
        } else if (column.x !== this.x && column.x + column.width > this.x + this.width) {
            // need to redraw entire screen.
            this.x += (column.x + column.width) - (this.x + this.width);
            if (this.x > column.x) {
                // give up, it's too wide for the screen.
                this.x = column.x;
            }
            this.printBrowser();
        } else {
            this.printPath(this.colIdx, this.rowIdx, true);
            this.printPath(oldColIdx, oldRowIdx, false);
        }
    }

    private printBrowser(): void {
        let columnIdx;

        // find first visible column
        for (columnIdx = 0; columnIdx < this.columns.length; ++columnIdx) {
            const column = this.columns[columnIdx];
            if (column.x + column.width > this.x) {
                break;
            }
        }

        if (columnIdx >= this.columns.length) {
            return;
        }

        if (!this.teletext) {
            this.print(this.normal);
        }

        this.printCLS();

        this.printCursorVisible(false);

        while (columnIdx < this.columns.length) {
            const column = this.columns[columnIdx];

            if (column.x >= this.x + this.width) {
                break;
            }

            for (let y = 0; y < column.rows.length; ++y) {
                this.printPath(columnIdx, y, y === this.rowIdx && columnIdx === this.colIdx ? true : undefined);
            }

            ++columnIdx;
        }

        this.printTAB(0, this.height - 1);
        if (this.width < 40) {
            // 01234567890123456789
            // 9999/9999 total
            this.print(this.numFilteredVolumes + '/' + this.volumes.length);
        } else {
            // 0123456789012345678901234567890123456789
            // 9999 shown (9999 total)
            this.print(this.numFilteredVolumes + ' shown (' + this.volumes.length + ' total)');
        }
    }

    private print(str: string): void {
        this.prints.writeString(str);
    }

    private printCursorVisible(visible: boolean): void {
        this.prints.writeUInt8(23, 1, visible ? 1 : 0, 0, 0, 0, 0, 0, 0, 0);
    }

    private printCLS(): void {
        this.prints.writeUInt8(12);
    }

    private printTAB(x: number, y: number): void {
        this.prints.writeUInt8(31, x, y);
    }

    private printFinish(): void {
        this.printCLS();

        this.printCursorVisible(true);
    }

    private createString(...chars: number[]): string {
        return Buffer.from(chars).toString('binary');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////
