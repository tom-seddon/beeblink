import * as utils from './utils';
import { BNL } from './utils';
import * as crypto from 'crypto';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Stats {
    public numTests = 0;
    public numBytes = 0;
    public sendTimeSeconds = 0;
    public recvTimeSeconds = 0;
    public lastHash: string | undefined;
    public allMatch = true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class SpeedTest {
    private hostStats: Stats;
    private parasiteStats: Stats;
    private lastNumBytes: number;
    private lastHash: string | undefined;

    public constructor() {
        this.hostStats = new Stats();
        this.parasiteStats = new Stats();
        this.lastNumBytes = 0;
    }

    public gotTestData(testData: Buffer) {
        const hasher = crypto.createHash('sha1');

        hasher.update(testData);

        this.lastHash = hasher.digest('hex');
        this.lastNumBytes = testData.length;
    }

    public addStats(parasite: boolean, sendTimeSeconds: number, recvTimeSeconds: number): void {
        const stats = parasite ? this.parasiteStats : this.hostStats;

        ++stats.numTests;

        stats.numBytes += this.lastNumBytes;
        this.lastNumBytes = 0;

        stats.sendTimeSeconds += sendTimeSeconds;
        stats.recvTimeSeconds += recvTimeSeconds;

        if (this.lastHash !== undefined) {
            if (stats.lastHash === undefined) {
                stats.lastHash = this.lastHash;
            } else {
                if (stats.lastHash !== this.lastHash) {
                    stats.allMatch = false;
                }
            }
        }
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
            }

            s += '  Send: ' + (stats.numBytes / stats.sendTimeSeconds / 1024).toFixed(2) + ' KBytes/sec' + BNL;
            s += '  Recv: ' + (stats.numBytes / stats.recvTimeSeconds / 1024).toFixed(2) + ' KBytes/sec' + BNL;
        }

        return s;
    }
}
