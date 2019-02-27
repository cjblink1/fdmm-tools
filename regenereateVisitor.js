#!/usr/bin/env node

const childProcess = require('child_process');
const async = require('async');
const path = require('path');
const fs = require('fs');

const GRAMMAR_EXTENSION = '.g4';

const main = () => {
    async.waterfall([
        verify,
        execute
    ], handleError);
}

const verify = (callback) => {
    async.waterfall([
        (callback) => verifyNumberOfArguments(process.argv, callback),
        (callback) => verifyFileExtension(process.argv, callback)
    ], callback);
}

const verifyNumberOfArguments = (argv, callback) => {
    if (argv.length < 3) {
        return callback(new Error('Not enough arguments'));
    }
    callback(null);
}

const verifyFileExtension = (argv, callback) => {
    const grammarFile = path.resolve(argv[2]);
    if ((ext = path.extname(grammarFile)) !== GRAMMAR_EXTENSION) {
        return callback(new Error(`Expected extension ${GRAMMAR_EXTENSION} but got ${ext}`));
    }
    callback(null);
}

const execute = (callback) => {
    const grammarFile = path.resolve(process.argv[2]);
    const grammarDirectory = path.dirname(grammarFile);
    const grammarName = path.basename(grammarFile, GRAMMAR_EXTENSION);
    const visitorFile = path.resolve(grammarDirectory, `${grammarName}Visitor.js`);
    async.waterfall([
        (callback) => renameOldVisitorIfNecessary(visitorFile, callback),
        (callback) => regenerateNewVisitor(grammarFile, callback),
        (callback) => mergeOldVisitorContentsIfOldVisitorExists(visitorFile, callback)
    ], callback);
}

const renameOldVisitorIfNecessary = (visitorFile, callback) => {
    fs.access(visitorFile, (err) => {
        if (err) {
            console.log(err.message, 'Skipping rename...');
            return callback(null);
        }
        renameOldVisitor(visitorFile, callback);
    });
}

const renameOldVisitor = (visitorFile, callback) => {
    fs.copyFile(visitorFile, `${visitorFile}.old`, (err) => {
        if (err) {
            return callback(new Error(`Could not rename ${visitorFile} to ${visitorFile}.old`));
        }
        console.log(`Renamed ${visitorFile} to ${visitorFile}.old`);
        callback(null);
    });
}

const regenerateNewVisitor = (grammarFile, callback) => {
    childProcess.exec(`java -jar /usr/local/lib/antlr-4.7.2-complete.jar -Dlanguage=JavaScript ${grammarFile} -visitor -no-listener`, (err) => {
        if (err) {
            return callback(new Error(`Could not regenerate visitor with antlr: ${err}`));
        }
        console.log(`Regenerated visitor from ${grammarFile} via antlr4`);
        callback(null);
    });
}

const mergeOldVisitorContentsIfOldVisitorExists = (visitorFile, callback) => {
    fs.access(`${visitorFile}.old`, (err) => {
        if (err) {
            console.log(err.message, 'Skipping merge...');
            return callback(null);
        }
        mergeOldVisitorContentsIfDifferent(visitorFile, callback);
    });
}

const mergeOldVisitorContentsIfDifferent = (visitorFile, callback) => {
    const oldVisitorFile = `${visitorFile}.old`;
    const oldVisitor = { lines: [], functions: new Map() };
    const visitor = { lines: [], functions: new Map() };
    const mergedVisitor = { lines: [], functions: new Map() };
    async.waterfall([
        (callback) => parseVisitor(oldVisitorFile, oldVisitor, callback),
        (callback) => parseVisitor(visitorFile, visitor, callback),
        (callback) => mergeAndGenerateIfDifferent(visitorFile, oldVisitor, visitor, mergedVisitor, callback)
    ], callback);
}

const parseVisitor = (file, visitor, callback) => {
    fs.readFile(file, (err, data) => {
        if (err) {
            return callback(new Error(`Could not parse visitor lines: ${err}`));
        }
        async.waterfall([
            (callback) => parseVisitorLines(data, visitor, callback),
            (callback) => populateVisitorFunctions(visitor, callback)
        ], callback);
    });
}

const parseVisitorLines = (data, visitor, callback) => {
    for (line of data.toString().split('\n')) visitor.lines.push(line);
    callback(null);
}

const populateVisitorFunctions = (visitor, callback) => {
    async.eachOfSeries(visitor.lines, (line, currentIndex, callback) => {
        if (line.includes('function(ctx)')) {
            const functionName = line.substring(0, line.indexOf('=') - 1);
            getFunctionBody(visitor, currentIndex, (err, functionBody) => {
                if (err) {
                    return callback(new Error(`Could not obtain function body: ${err}`));
                }
                visitor.functions.set(functionName, functionBody);
                return callback(null);
            });
        } else callback(null);
    }, callback);
}

const getFunctionBody = (visitor, currentIndex, callback) => {
    let functionBody = [];
    let numBraces = 0;
    do {
        functionBody.push(visitor.lines[currentIndex]);
        if (visitor.lines[currentIndex].includes('{')) numBraces++;
        if (visitor.lines[currentIndex].includes('}')) numBraces--;
        currentIndex++;
    } while (numBraces > 0);
    callback(null, functionBody.slice(1, -1));
}

const mergeAndGenerateIfDifferent = (visitorFile, oldVisitor, visitor, mergedVisitor, callback) => {
    equalVisitors(oldVisitor, visitor, (equal) => {
        if (equal) {
            console.log(`No difference between old visitor and new visitor. Skipping merge...`)
            return callback(null);
        }
        console.log(`Merging old visitor and new visitor`);
        async.waterfall([
            (callback) => mergeFunctions(oldVisitor, visitor, mergedVisitor, callback),
            (callback) => mergeLines(visitor, mergedVisitor, callback),
            (callback) => generateVisitorFile(visitorFile, mergedVisitor, callback)
        ], callback);
    });
}

const equalVisitors = (v0, v1, callback) => {
    if (v0.functions.size !== v1.functions.size) return callback(false);
    for (let [functionName, functionBody] of v0.functions.entries()) {
        if (!v1.functions.has(functionName)) return callback(false);
        for (let [index, line] of functionBody.entries()) {
            if (line !== v1.functions.get(functionName)[index]) return callback(false);
        };
    }
    callback(true);
}

const mergeFunctions = (oldVisitor, visitor, mergedVisitor, callback) => {
    async.each(visitor.functions, ([functionName, functionBody], callback) => {
        let mergedFunctionBody = functionBody;
        if (oldVisitor.functions.has(functionName)) {
            mergedFunctionBody = oldVisitor.functions.get(functionName);
        }
        mergedVisitor.functions.set(functionName, mergedFunctionBody);
        callback(null);
    }, callback);
}

const mergeLines = (visitor, mergedVisitor, callback) => {
    for (let line of visitor.lines) mergedVisitor.lines.push(line);
    for (let i = mergedVisitor.lines.length - 1; i >= 0; i--) {
        const currentLine = mergedVisitor.lines[i];
        if (currentLine.includes('function(ctx)')) {
            const functionName = currentLine.substring(0, currentLine.indexOf('=') - 1);
            const mergedFunctionBody = mergedVisitor.functions.get(functionName);
            mergedVisitor.lines.splice(i + 1, 1);
            Array.prototype.splice.apply(mergedVisitor.lines, [i + 1, 0].concat(mergedFunctionBody));
        }
    }
    callback(null);
}

const generateVisitorFile = (visitorFile, mergedVisitor, callback) => {
    fs.writeFile(visitorFile, mergedVisitor.lines.join('\n'), (err) => {
        if (err) {
            return callback(new Error(`Could not generate new visitor file: ${err}`));
        }
        console.log(`Generated new visitor file: ${visitorFile}`);
        callback(null);
    });
}

const handleError = (err) => {
    if (err) {
        console.log(`${err.name}: ${err.message}`);
    }
}

main();

