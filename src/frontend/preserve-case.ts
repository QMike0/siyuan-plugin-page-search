/**
 * 按命中文本大小写形态调整替换文本（foo→bar / FOO→BAR / Foo→Bar）。
 * 自 sou-easy preserve-case 移植。
 */
export function preserveReplacementCase(replacementText: string, matchedText: string): string {
    if (!replacementText || !matchedText || !hasCaseAwareLetters(matchedText)) {
        return replacementText;
    }

    if (matchedText === matchedText.toLocaleUpperCase()) {
        return replacementText.toLocaleUpperCase();
    }

    if (matchedText === matchedText.toLocaleLowerCase()) {
        return replacementText.toLocaleLowerCase();
    }

    if (isTitleCaseText(matchedText)) {
        return toTitleCaseText(replacementText);
    }

    return replacementText;
}

function hasCaseAwareLetters(value: string): boolean {
    return value.toLocaleLowerCase() !== value.toLocaleUpperCase();
}

function isLetter(char: string): boolean {
    return hasCaseAwareLetters(char);
}

function isTitleCaseText(value: string): boolean {
    let shouldUppercase = true;
    let sawLetter = false;

    for (const char of value) {
        if (!isLetter(char)) {
            if (/[^\p{L}\p{N}]/u.test(char)) {
                shouldUppercase = true;
            }
            continue;
        }

        sawLetter = true;
        if (shouldUppercase) {
            if (char !== char.toLocaleUpperCase()) {
                return false;
            }
            shouldUppercase = false;
            continue;
        }

        if (char !== char.toLocaleLowerCase()) {
            return false;
        }
    }

    return sawLetter;
}

function toTitleCaseText(value: string): string {
    let shouldUppercase = true;
    let result = "";

    for (const char of value) {
        if (!isLetter(char)) {
            result += char;
            if (/[^\p{L}\p{N}]/u.test(char)) {
                shouldUppercase = true;
            }
            continue;
        }

        result += shouldUppercase
            ? char.toLocaleUpperCase()
            : char.toLocaleLowerCase();
        shouldUppercase = false;
    }

    return result;
}
