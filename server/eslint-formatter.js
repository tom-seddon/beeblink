// https://eslint.org/docs/latest/extend/custom-formatters
//
// This is a simple one that produces clickable output in the Visual Studio Code
// output window.

module.exports = async function (results) {
    const lines = [];
    results.forEach((result) => {
        result.messages.forEach((message) => {
            let line = '';

            line += `${result.filePath}:${message.line || 0}:${message.column || 0}: `;

            if (message.fatal || message.severity === 2) {
                line += 'ERROR';
            } else {
                line += 'WARNING';
            }

            line += `: ${message.message}`;

            if (message.ruleId) {
                line += ` (${message.ruleId})`;
            }

            lines.push(line);
        });
    });

    return lines.join("\n");
};
