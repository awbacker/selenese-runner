// # Script for running a collection of testsuites
//
// This is an utility for sending collections of selenese-test-suites
// to selenium-servers. The following is the code documentation. 
// Usage documentation and tests are at: [https://github.com/DBC-as/selenese-runner](https://github.com/DBC-as/selenese-runner)
//
// The code consists of two main parts:
//
// - the main function, `runWithConfig`, is responsible for sending the
//   collection of selenese-test-suites to a selenium server.
// - a reporting function, `junitReporter` that creates the final testreport.
//
// The reporting function will be called for each event that
// happens during the test. Events are JavaScript-objects, such as
// `{testcase: "testcasename"}` with info about which test will be run next,
// `{error: "some error message", ...}` if errors occurs, or
// `{testDone: true}` which will be be called as the last
// event at the end of every collection of testsuites. See the use of
// `config.callback` below, to understand when events are emitted.
//
// The main function is asynchronous, which makes it easy to run several
// collections of testsuites in parallel, possibly talking with different
// selenium servers.
//

// ## Dependencies
//var soda = require('soda');                                   // selenium
var wdSync = require('wd-sync');                                // Selenium
var temp = require('temp');                                // Manage temporary files.
var fs = require('fs');                                         // file system
var request = require('request');                               // http(s) requests
var async = require('async');                                   // asynchronous utilities
var assert = require('assert');                                 // CommonJS assert for testing
var converter = require("selenium-html-js-converter");    // Converter of Selenese HTML files to WD Sync files.

// Automatically track and cleanup files at exit
temp.track();

// ## Main function
//
// The `config` parameter is an object, which may contain the following properties:
//
// - `config.url` may be the url of the site to test. If this is not present, there must be an url-property in config.setup
// - `config.suitelist` must be the filename/url to the list of selenium-ide suites. The filname/urls to the suites are relative to the `config.suitelist` path.
// - `config.selenium` describes where to find the selenium server, - passed to soda. If omitted it will try to connect to a locally running server. This also handles connection to saucelabs if credentials is available.
// - `config.saucelabs` describes the data to use it with saucelabs.
// - `config.desiredCapabilities` describes the browser needed to launch the tests.
// - `config.replace` is an optional object with values that should be replaced, - useful for substituting username/password in public visible testcases
// - `config.callback` must be a function that handles reporting the progress and results of the tests. Has single parameter which is an object with the event.
//
exports.runWithConfig = function(config) {
    var basePath = config.suitelist.replace(/[^/]*$/, '');
    var saucelabsDefaultConn = {
        host: 'ondemand.saucelabs.com',
        port: 80
    };
    var saucelabs = config.saucelabs || false;
    var url = config.url;
    var seleniumServer = config.selenium || {};
    var desiredCapabilities = config.desiredCapabilities || { browserName: 'firefox'};
    var host = seleniumServer.host || 'localhost';
    var port = seleniumServer.port || '4444';
    var client;
    var browser;
    var sync;

    // Url is needed to perform the tests so if it's not supplied we throw an error.
    if(!url){
        throw new Error('To launch tests you need to supply a valir url.');
    }

    // Connect to selenium (either in the cloud(sauce) or on internal server).
    if(saucelabs){
        client = wdSync.remote(
            saucelabsDefaultConn.host,
            saucelabsDefaultConn.port,
            saucelabs.username,
            saucelabs.accessKey);
    }else{
        if(desiredCapabilities.browserName === 'phantomjs'){
            // @TODO Wake up the server of phantomjs if it doesn't exist
        }
        client  = wdSync.remote(host, port);
    }

    browser = client.browser;
    sync = client.sync;

    // Load the list of suites,
    config.callback({info: 'loading suitelist', url: config.suitelist});


    read(config.suitelist, function(err, data) {
        if (!data || err) {
            console.log(err, data);
            throw err;
        }

        config.callback({info: 'starting new browser-session'});
        // and start a new browser-session.
        sync(function (){
            var sessionId;
            // Create the connection with browser and open it.
            browser.init(desiredCapabilities);
            // Set the url to start the test.
            browser.get(url);
            // Notify anyone who's interested in the session ID (eg. for Saucelabs API)
            sessionId = browser.getSessionId();
            if(sessionId){
                config.callback({sid: sessionId});
            }else{
                return config.callback({
                    error: "Internal error, could not start browser",
                    err: err,
                    testDone: true});
            }
            // Remove comments in suitelist (comment lines start with #),
            // and convert it to an array of names of suites.
            var suiteNames = data
                .replace(/#.*/g, '')
                .split(/[ \t]*\r?\n/)
                .filter(function(e) {
                    return e !== '';
                });
            // Then execute each of the suites.
            suiteNames.forEach(executeSuite);
            config.callback({testDone: true});
            browser.quit();
        });

    });


    // ### Load, process and execute a testsuite
    function executeSuite(suiteName) {
        config.callback({testsuite: suiteName});

        // Load the testsuite.
        config.callback({info: 'loading testsuite', url: basePath + suiteName});
        read(basePath + suiteName, function(err, data) {
            if (!data || err) {
                console.log(err, data);
                throw err;
            }

            // If the suite is not a valid selenium-ide suite,
            // report an error, and skip to next suite.
            if (!data.match('<table id="suiteTable" cellpadding="1" ' +
                    'cellspacing="1" border="1" class="selenium">')) {
                config.callback({
                    testcase: 'error-before-testcase-reached'});
                config.callback({
                    error: "Testsuite doesn't look like a testsuite-" +
                            "file from selenium-IDE. Check that the " +
                            "url actually exists",
                    url: basePath + suiteName
                });
            }

            // Extract the names of the tests from the testsuite.
            //
            // HACK: unfortunately `.replace` is the way to map
            // a function across regex results and automatically extract
            // the grouping to sensible named variables.
            var tests = [];
            data.replace(/<a href="([^"]*)">([^<]*)/g,
                    function(_, href, text) {
                        tests.push(href);
                    });

            // Path which the test filename is relative to.
            suitePath = (basePath + suiteName).replace(/[^/]*$/, '');

            // A global to make sure that test-cases can occure more than once en a test-suite
            global.cnt = 0;

            // Load, parse,
            tests.forEach(function (elem){
                parseTest(suitePath, elem);
            });
    });
    }


    // ### Load and parse a testcase
    // The testcases will be stored in the testcaseAccumulator.
    function parseTest(suitePath, test) {
        // Load the testcase.
        config.callback({info: 'loading testsuite', url: suitePath + test});
        read(suitePath + test, function(err, data) {
            var info, test1;
            if (!data || err) {
                console.log(err, data);
                throw err;
            }


            // Parse the test.
            //
            // HACK: unfortunately `.replace` is the way to map
            // a function across regex results and automatically extract
            // the grouping to sensible named variables.
            info = temp.openSync('testsuiteJs_'+test);
            converter.convertHtmlStrToJsFile(data, info.path);
            test1 = require(info.path);
            test1(browser);
        });
    }

    // ### Preprocess testcases in a suite and execute them
    // Support for beforeEach and afterEach special test case
    // which is pre-/appended to the other testcases
    function prepareAndExecuteTests(testcases, nextSuiteCallback) {
        var beforeEach = testcases.beforeEach || [];
        delete testcases.beforeEach;
        var afterEach = testcases.afterEach || [];
        delete testcases.afterEach;

        Object.keys(testcases).forEach(function(key) {
            testcases[key] =
                    beforeEach.concat(testcases[key], afterEach);
        });

        // Transform object to a list of objects,
        // for easier accesss. Then execute the tests.
        tests = Object.keys(testcases).map(function(key) {
            return {name: key, commands: testcases[key]};
        });
        async.forEachSeries(tests,
                function(elem, doneCallback) {
                    executeTestCase(elem, doneCallback, nextSuiteCallback);
                }, nextSuiteCallback);
    }

    // ### Execute all commands in a single testcase
    function executeTestCase(test, nextTestCallback,
            nextSuiteCallback) {
        config.callback({testcase: test.name});

        async.forEachSeries(test.commands,
                function(command, doneCallback) {
                    executeCommand(command, doneCallback,
                            nextTestCallback);
                }, nextTestCallback);
    }

    // ### Execute a single selenium command
    function executeCommand(command, doneCallback,
            nextTestCallback) {
        config.callback({
            info: "executing command",
            command: command.command,
            target: command.target,
            value: command.value});

        // Require that urls are relative,
        // as the tests should both be usable
        // both on test-setups and actual deployed services
        if (false && command.command === 'open' && command.target.match(/https?:\/\//i)) {
            command.target = command.target.replace(/https?:\/\/[^\/]*/i, '');
            config.callback({
                warning: 'Got an absolute url. ' +
                        'Stripped hostname, to connect ' +
                        'to the supplied servername/url',
                command: command.command,
                target: command.target,
                value: command.value});
        }

        // Handle a custom command: `restartBrowser`,
        if (command.command === 'restartBrowser') {
            browser.testComplete(function() {
                browser.session(function(err) {
                    if (err) {
                        return config.callback({
                            error: "Internal Error",
                            err: err,
                            testDone: true});
                    }
                    // and jump to the next selenese command when done.
                    doneCallback();
                });
            });
            return;

            // Handle unknown commands or
        } else if (!browser[command.command]) {
            config.callback({
                error: 'Unknown command',
                command: command.command,
                target: command.target,
                value: command.value
            });
            return nextTestCallback();
        }

        // and send the command to browser.
        browser[command.command](command.target, command.value,
                function(err, response, obj) {
                    // If sending the command fails, skip to next test.
                    if (err !== null) {
                        config.callback({
                            error: err,
                            command: command.command,
                            target: command.target,
                            value: command.value
                        });
                        return nextTestCallback();
                    }
                    // If the result of the command, is failure,
                    // signal an error.
                    if (response === 'false') {
                        config.callback({
                            error: "Command return false",
                            command: command.command,
                            target: command.target,
                            value: command.value});
                    }
                    // Continue with the next command.
                    doneCallback();
                });
    }

    return browser;
};

// ## JUnit-compatible reporting callback

// ### Static variables
// Several junit-reporters can be active at once, - there will typically be one per testcollection run by `runWithConfig`.
// when the last report quits, the program exits with the total `errorCount` as exit code.
// `junitReporters` keeps track of the number of running `junitReporter`s
var junitReporters = 0;
var errorCount = 0;

// ### The reporting function generator
// The function itself create a new reporting function, which will write the testreport in a given `filename`.
exports.junitReporter = (function(filename) {
    ++junitReporters;

    // During the execution it keeps track of the current `suite`-name and `testcase`, and then record the testresult in the `results`-object. `errorDetected` keeps track that we only report one error per testcase, even if there are several failures.
    var suite, testcase;
    var results = {};
    var errorDetected = false;

    // #### Generate xml report
    // Transform to junit-like xml for Jenkins
    function results2xml() {
        var result = ['<testsuite name="root">\n'];
        Object.keys(results).forEach(function(suite) {
            result.push('<testsuite name="' + escapexml(suite) + '">');
            Object.keys(results[suite]).forEach(function(testcase) {
                result.push('<testcase name="' +
                        escapexml(testcase) + '">');
                results[suite][testcase].forEach(function(err) {
                    result.push('<failure>' +
                            escapexml(JSON.stringify(err)) +
                            '</failure>');
                });
                result.push('</testcase>');
            });
            result.push('</testsuite>\n');
        });
        result.push('</testsuite>\n');
        return result.join('');
    }

    // #### Callback function accumulating test results
    return function(msg) {
        console.log(JSON.stringify([filename, (new Date()).getTime(), msg]));
        if (msg.testsuite) {
            suite = msg.testsuite;
            results[suite] = results[suite] || {};
        }
        if (msg.testcase) {
            errorDetected = false;
            testcase = msg.testcase;
            results[suite][testcase] = results[suite][testcase] || [];
        }
        if (msg.error) {
            results[suite][testcase].push(msg);
            if (!errorDetected) {
                errorCount++;
                errorDetected = true;
            }
        }
        // Exit with error code when all JunitReporters are done.
        if (msg.testDone) {
            fs.writeFile(filename, results2xml(), function() {
                --junitReporters;
                if (junitReporters === 0) {
                    process.exit(errorCount);
                }
            });
        }
    };
});

// # Easy dispatch across different setups
exports.easyDispatch = function(params) {
    var tasks = objectCross(params);
    tasks.forEach(function(task) {
        var reportName = '';
        reportName += task.suitelist
                .replace(/.*\//, '')
                .replace(/[^a-zA-Z0-9-_]+/g, '-');
        reportName += '-' + task.setup.host;
        reportName += '-' + task.setup.browser;
        reportName += task.url.slice(5).replace(/[^a-zA-Z0-9-_]+/g, '-');
        reportName += '.xml';
        task.callback = exports.junitReporter(reportName);
        ;
        exports.runWithConfig(task);
    });
}

// ## Do the cross product of the properties of an object
// Transform an object, where some of its property-values are arrays
// to a list of objects, where the array-values are converted to simple values,
// and all combinations of the array-values leads to a new object.
function objectCross(params) {
    var objs = [params];

    Object.keys(params).forEach(function(key) {
        var vals = params[key];
        if (!Array.isArray(vals)) {
            return;
        }
        var result = [];
        vals.forEach(function(value) {
            objs.forEach(function(obj) {
                var newObj = Object.create(obj);
                newObj[key] = value;
                result.push(newObj);
            });
            objs = result;
        });
    });
    return objs;
}

// ## Unit testing
exports.testEasyDispatch = function() {

    // test objectCross
    assert.deepEqual(objectCross({foo: 1, bar: 2, baz: 3}),
    [{foo: 1, bar: 2, baz: 3}]);
    assert.deepEqual(objectCross({foo: 1, bar: [2, 3], baz: [4, 5]})
            .map(flattenObject), [
        {foo: 1, bar: 2, baz: 4},
        {foo: 1, bar: 3, baz: 4},
        {foo: 1, bar: 2, baz: 5},
        {foo: 1, bar: 3, baz: 5}]);
}


// ## Utility code
// ### xml escape/unescape
// TODO: extract to library
function escapexml(str) {
    return str.replace(/[^ !#-;=?-~\n\r\t]/g, function(c) {
        return '&#' + c.charCodeAt(0) + ';';
    });
}

function unescapexml(str) {
    return str.replace(/&([a-zA-Z0-9]*);/g, function(orig, entity) {
        var entities = { 
            gt: '>', 
            lt: '<', 
            quot: '"', 
            nbsp: '\xa0',
            amp: '&' };
        if(entities[entity]) {
            return entities[entity];
        }
        throw({
            error: 'Internal error, cannot convert entity',
            entity: entity,
            str: str
        });
    });
}


// ### Easy reading from url or file
// TODO: extract to library
function read(filename, callback) {
    if (filename.match(/^https?:\/\//i)) {
        request(filename, function(err, response, data) {
            callback(err, data);
        });
    } else {
        var data = fs.readFileSync(filename, 'utf-8');
        callback(null, data);
    }
}

// ### Make a flat copy of an object, including prototype properties
function flattenObject(obj) {
    var result = {};
    for (key in obj) {
        result[key] = obj[key];
    }
    return result;
}
