/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class BeebError extends Error {
    public readonly code: number;
    public readonly text: string;

    public constructor(code: number, text: string) {
        super(text + ' (' + code + ')');

        this.code = code;
        this.text = text;
    }

    public toString() {
        return this.message;
    }
}

function createErrorFactory(code: number, defaultMessage: string): (message?: string) => never {
    return (message?: string): never => {
        throw new BeebError(code, message === undefined ? defaultMessage : message);
    };
}

export const tooManyOpen = createErrorFactory(192, 'Too many open');
export const readOnly = createErrorFactory(193, 'Read only');
export const open = createErrorFactory(194, 'Open');
export const locked = createErrorFactory(195, 'Locked');
export const exists = createErrorFactory(196, 'Exists');
export const tooBig = createErrorFactory(198, 'Too big');
export const discFault = createErrorFactory(199, 'Disc fault');
export const volumeReadOnly = createErrorFactory(201, 'Volume read only');
export const badName = createErrorFactory(204, 'Bad name');
export const badDrive = createErrorFactory(205, 'Bad drive');
export const badDir = createErrorFactory(206, 'Bad dir');
export const badAttribute = createErrorFactory(207, 'Bad attribute');
export const fileNotFound = createErrorFactory(214, 'File not found');
// Empty message for 220 directs the server to create a suitable one
// automatically.
export const syntax = createErrorFactory(220, '');
export const channel = createErrorFactory(222, 'Channel');
export const eof = createErrorFactory(223, 'EOF');
export const badString = createErrorFactory(253, 'Bad string');
export const badCommand = createErrorFactory(254, 'Bad command');
export const dataLost = createErrorFactory(0xca, 'Data lost');
export const wont = createErrorFactory(0x93, 'Won\'t');

export function generic(message: string): never {
    throw new BeebError(199, message);
}
