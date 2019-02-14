import * as utils from './utils';
import { BNL } from './utils';
import * as crypto from 'crypto';
import * as assert from 'assert';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Stats {
    public numTests = 0;
    public numBytes = 0;
    public sendTimeSeconds = 0;
    public recvTimeSeconds = 0;

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

    public constructor() {
        this.hostStats = new Stats();
        this.parasiteStats = new Stats();
    }

    public gotTestData(parasite: boolean, data: Buffer, log: utils.Log): Buffer {
        const stats = parasite ? this.parasiteStats : this.hostStats;

        if (stats.originalData === undefined) {
            stats.originalData = data;
        }

        if (stats.expectedData !== undefined) {
            if (data.length !== stats.expectedData.length) {
                log.pn('** data length mismatch');
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

                log.pn('** f=' + f + ', n=' + n);
            }

            if (!data.equals(stats.expectedData)) {
                stats.allMatch = false;
            }
        }

        // Send back alternating random junk or original data.
        if (stats.numTests++ % 2 === 0) {
            stats.expectedData = crypto.randomBytes(stats.originalData.length);
        } else {
            stats.expectedData = stats.originalData;
        }

        return stats.expectedData;
    }

    public addStats(parasite: boolean, sizeBytes: number, sendTimeSeconds: number, recvTimeSeconds: number) {
        const stats = parasite ? this.parasiteStats : this.hostStats;

        stats.numBytes += sizeBytes;
        stats.sendTimeSeconds += sendTimeSeconds;
        stats.recvTimeSeconds += recvTimeSeconds;
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
                console.log('not all transfers matched...');
            }

            s += '  Send: ' + (stats.numBytes / stats.sendTimeSeconds / 1024).toFixed(2) + ' KBytes/sec' + BNL;
            s += '  Recv: ' + (stats.numBytes / stats.recvTimeSeconds / 1024).toFixed(2) + ' KBytes/sec' + BNL;
        }

        return s;
    }
}
