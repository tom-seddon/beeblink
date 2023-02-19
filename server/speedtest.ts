import * as utils from './utils';
import { BNL } from './utils';
import * as crypto from 'crypto';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Stats {
    public numTests = 0;
    public numBytes = 0;

    // send and recv are from the PC perspective.
    public serverSendTimeSeconds = 0;
    public serverRecvTimeSeconds = 0;

    public originalData: Buffer | undefined;
    public expectedData: Buffer | undefined;
    public lastHash: string | undefined;
    public allMatch = true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class SpeedTest {
    private hostStats: Stats;
    private parasiteStats: Stats;
    private lastHRTime: [number, number];

    public constructor() {
        this.hostStats = new Stats();
        this.parasiteStats = new Stats();
        this.lastHRTime = process.hrtime();
    }

    public gotTestData(parasite: boolean, data: Buffer, log: utils.Log | undefined): Buffer {
        const stats = parasite ? this.parasiteStats : this.hostStats;

        if (stats.originalData === undefined) {
            stats.originalData = data;
        }

        if (stats.expectedData !== undefined) {
            if (data.length !== stats.expectedData.length) {
                log?.pn('** data length mismatch');
            } else {
                let n = 0;
                let f = -1;
                for (let i = 0; i < data.length; ++i) {
                    if (data[i] !== stats.expectedData[i]) {
                        if (f < 0) {
                            f = i;
                        }
                        ++n;
                    }
                }

                log?.pn('** f=' + f + ', n=' + n);
            }

            if (!data.equals(stats.expectedData)) {
                if (data.length !== stats.expectedData.length) {
                    process.stderr.write(`Speed test expected ${stats.expectedData.length} bytes, got ${data.length} bytes\n`);
                } else {
                    for (let i = 0; i < data.length; ++i) {
                        if (data[i] !== stats.expectedData[i]) {
                            const stderr = new utils.Log('', process.stderr, true);

                            stderr.pn(`Speed test first mismatch at +${i} (0x${utils.hex8(i)}) - expected 0x${utils.hex2(stats.expectedData[i])}, got 0x${utils.hex2(data[i])}`);

                            stderr.pn(`Expected:`);
                            stderr.dumpBuffer(stats.expectedData);
                            stderr.pn(``);

                            stderr.pn(`Got:`);
                            stderr.dumpBuffer(data);
                            stderr.pn(``);

                            break;
                        }
                    }
                }
                stats.allMatch = false;
            }
        }

        // Send back alternating random junk or original data.
        if (stats.numTests++ % 2 === 0) {
            stats.expectedData = crypto.randomBytes(stats.originalData.length);
        } else {
            stats.expectedData = stats.originalData;
        }

        const diff = process.hrtime(this.lastHRTime);
        stats.serverRecvTimeSeconds += diff[0] + diff[1] / 1e9;
        this.lastHRTime = process.hrtime();

        return stats.expectedData;
    }

    public addStats(parasite: boolean, sizeBytes: number) {
        const stats = parasite ? this.parasiteStats : this.hostStats;

        stats.numBytes += sizeBytes;

        const diff = process.hrtime(this.lastHRTime);
        stats.serverSendTimeSeconds += diff[0] + diff[1] / 1e9;
        this.lastHRTime = process.hrtime();
    }

    public getString(): string {
        let s = '';

        s += this.getStatsString(this.hostStats, 'Host');
        s += this.getStatsString(this.parasiteStats, 'Parasite');

        if (s.length === 0) {
            s = 'No results' + BNL;
        }

        return s;
    }

    private getStatsString(stats: Stats, name: string): string {
        let s = '';

        if (stats.numTests > 0) {
            s += name + '<->server: ' + stats.numBytes.toLocaleString() + ' bytes in ' + stats.numTests + ' tests' + BNL;

            if (!stats.allMatch) {
                s += '  ** Not all transfers matched **' + BNL;
                process.stderr.write('Not all speed test transfers matched...\n');
            }

            s += '    BBC->PC: ' + (stats.numBytes / stats.serverRecvTimeSeconds / 1024).toFixed(1) + ' KBytes/sec' + BNL;
            s += '    PC->BBC: ' + (stats.numBytes / stats.serverSendTimeSeconds / 1024).toFixed(1) + ' KBytes/sec' + BNL;
        }

        return s;
    }
}
