// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke and various contributors and
// released under an MIT license. The Unicode regexps (for identifiers
// and whitespace) were taken from [Esprima](http://esprima.org) by
// Ariya Hidayat.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues
//
// This file defines the main parser interface. The library also comes
// with a [error-tolerant parser][dammit] and an
// [abstract syntax tree walker][walk], defined in other files.
//
// [dammit]: acorn_loose.js
// [walk]: util/walk.js

(function(root, mod) {
if (typeof exports == "object" && typeof module == "object") return mod(exports); // CommonJS
if (typeof define == "function" && define.amd) return define(["exports"], mod); // AMD
mod(root.acorn || (root.acorn = {})); // Plain browser env
})(this, function(exports) {
"use strict";

exports.version = "0.7.0";

// The main exported interface (under `self.acorn` when in the
// browser) is a `parse` function that takes a code string and
// returns an abstract syntax tree as specified by [Mozilla parser
// API][api], with the caveat that inline XML is not recognized.
//
// [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API

var options, input, inputLen, sourceFile;

exports.parse = function(inpt, opts) {
	input = String(inpt); inputLen = input.length;
	setOptions(opts);
	initTokenState();
	return parseTopLevel(options.program);
};

// A second optional argument can be given to further configure
// the parser process. These options are recognized:

var defaultOptions = exports.defaultOptions = {
	// `ecmaVersion` indicates the ECMAScript version to parse. Must
	// be either 3, or 5, or 6. This influences support for strict
	// mode, the set of reserved words, support for getters and
	// setters and other features.
	ecmaVersion: 5,
	// Turn on `strictSemicolons` to prevent the parser from doing
	// automatic semicolon insertion.
	strictSemicolons: false,
	// When `allowTrailingCommas` is false, the parser will not allow
	// trailing commas in array and object literals.
	allowTrailingCommas: true,
	// By default, reserved words are not enforced. Enable
	// `forbidReserved` to enforce them. When this option has the
	// value "everywhere", reserved words and keywords can also not be
	// used as property names.
	forbidReserved: false,
	// When enabled, a return at the top level is not considered an
	// error.
	allowReturnOutsideFunction: false,
	// When `locations` is on, `loc` properties holding objects with
	// `start` and `end` properties in `{line, column}` form (with
	// line being 1-based and column 0-based) will be attached to the
	// nodes.
	locations: false,
	// A function can be passed as `onToken` option, which will
	// cause Acorn to call that function with object in the same
	// format as tokenize() returns. Note that you are not
	// allowed to call the parser from the callback—that will
	// corrupt its internal state.
	onToken: null,
	// A function can be passed as `onComment` option, which will
	// cause Acorn to call that function with `(block, text, start,
	// end)` parameters whenever a comment is skipped. `block` is a
	// boolean indicating whether this is a block (`/* */`) comment,
	// `text` is the content of the comment, and `start` and `end` are
	// character offsets that denote the start and end of the comment.
	// When the `locations` option is on, two more parameters are
	// passed, the full `{line, column}` locations of the start and
	// end of the comments. Note that you are not allowed to call the
	// parser from the callback—that will corrupt its internal state.
	onComment: null,
	// Nodes have their start and end characters offsets recorded in
	// `start` and `end` properties (directly on the node, rather than
	// the `loc` object, which holds line/column data. To also add a
	// [semi-standardized][range] `range` property holding a `[start,
	// end]` array with the same numbers, set the `ranges` option to
	// `true`.
	//
	// [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
	ranges: false,
	// It is possible to parse multiple files into a single AST by
	// passing the tree produced by parsing the first file as
	// `program` option in subsequent parses. This will add the
	// toplevel forms of the parsed file to the `Program` (top) node
	// of an existing parse tree.
	program: null,
	// When `locations` is on, you can pass this to record the source
	// file in every node's `loc` object.
	sourceFile: null,
	// This value, if given, is stored in every node, whether
	// `locations` is on or off.
	directSourceFile: null
};

function setOptions(opts) {
	options = opts || {};
	for (var opt in defaultOptions) if (!has(options, opt))
	options[opt] = defaultOptions[opt];
	sourceFile = options.sourceFile || null;

	isKeyword = options.ecmaVersion >= 6 ? isEcma6Keyword : isEcma5AndLessKeyword;
}

// The `getLineInfo` function is mostly useful when the
// `locations` option is off (for performance reasons) and you
// want to find the line/column position for a given character
// offset. `input` should be the code string that the offset refers
// into.

var getLineInfo = exports.getLineInfo = function(input, offset) {
	for (var line = 1, cur = 0;;) {
	lineBreak.lastIndex = cur;
	var match = lineBreak.exec(input);
	if (match && match.index < offset) {
		++line;
		cur = match.index + match[0].length;
	} else break;
	}
	return {line: line, column: offset - cur};
};

var getCurrentToken = function () {
	var token = {
	type: tokType,
	value: tokVal,
	start: tokStart,
	end: tokEnd
	};
	if (options.locations) {
	token.startLoc = tokStartLoc;
	token.endLoc = tokEndLoc;
	}
	return token;
};

// Acorn is organized as a tokenizer and a recursive-descent parser.
// The `tokenize` export provides an interface to the tokenizer.
// Because the tokenizer is optimized for being efficiently used by
// the Acorn parser itself, this interface is somewhat crude and not
// very modular. Performing another parse or call to `tokenize` will
// reset the internal state, and invalidate existing tokenizers.

exports.tokenize = function(inpt, opts) {
	input = String(inpt); inputLen = input.length;
	setOptions(opts);
	initTokenState();

	function getToken(forceRegexp) {
	lastEnd = tokEnd;
	readToken(forceRegexp);
	return getCurrentToken();
	}
	getToken.jumpTo = function(pos, reAllowed) {
	tokPos = pos;
	if (options.locations) {
		tokCurLine = 1;
		tokLineStart = lineBreak.lastIndex = 0;
		var match;
		while ((match = lineBreak.exec(input)) && match.index < pos) {
		++tokCurLine;
		tokLineStart = match.index + match[0].length;
		}
	}
	tokRegexpAllowed = reAllowed;
	skipSpace();
	};
	return getToken;
};

// State is kept in (closure-)global variables. We already saw the
// `options`, `input`, and `inputLen` variables above.

// The current position of the tokenizer in the input.

var tokPos;

// The start and end offsets of the current token.

var tokStart, tokEnd;

// When `options.locations` is true, these hold objects
// containing the tokens start and end line/column pairs.

var tokStartLoc, tokEndLoc;

// The type and value of the current token. Token types are objects,
// named by variables against which they can be compared, and
// holding properties that describe them (indicating, for example,
// the precedence of an infix operator, and the original name of a
// keyword token). The kind of value that's held in `tokVal` depends
// on the type of the token. For literals, it is the literal value,
// for operators, the operator name, and so on.

var tokType, tokVal;

// Internal state for the tokenizer. To distinguish between division
// operators and regular expressions, it remembers whether the last
// token was one that is allowed to be followed by an expression.
// (If it is, a slash is probably a regexp, if it isn't it's a
// division operator. See the `parseStatement` function for a
// caveat.)

var tokRegexpAllowed;

// When `options.locations` is true, these are used to keep
// track of the current line, and know when a new line has been
// entered.

var tokCurLine, tokLineStart;

// These store the position of the previous token, which is useful
// when finishing a node and assigning its `end` position.

var lastStart, lastEnd, lastEndLoc;

// This is the parser's state. `inFunction` is used to reject
// `return` statements outside of functions, `inGenerator` to
// reject `yield`s outside of generators, `labels` to verify
// that `break` and `continue` have somewhere to jump to, and
// `strict` indicates whether strict mode is on.

var inFunction, inGenerator, labels, strict;

// This counter is used for checking that arrow expressions did
// not contain nested parentheses in argument list.

var metParenL;

// This is used by parser for detecting if it's inside ES6
// Template String. If it is, it should treat '$' as prefix before
// '{expression}' and everything else as string literals.

var inTemplate;

// This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.

function raise(pos, message) {
	var loc = getLineInfo(input, pos);
	message += " (" + loc.line + ":" + loc.column + ")";
	var err = new SyntaxError(message);
	err.pos = pos; err.loc = loc; err.raisedAt = tokPos;
	throw err;
}

// Reused empty array added for node fields that are always empty.

var empty = [];

// ## Token types

// The assignment of fine-grained, information-carrying type objects
// allows the tokenizer to store the information it has about a
// token in a way that is very cheap for the parser to look up.

// All token type variables start with an underscore, to make them
// easy to recognize.

// These are the general types. The `type` property is only used to
// make them recognizeable when debugging.

var _num = {type: "num"}, _regexp = {type: "regexp"}, _string = {type: "string"};
var _name = {type: "name"}, _eof = {type: "eof"};

// Keyword tokens. The `keyword` property (also used in keyword-like
// operators) indicates that the token originated from an
// identifier-like word, which is used when parsing property names.
//
// The `beforeExpr` property is used to disambiguate between regular
// expressions and divisions. It is set on all token types that can
// be followed by an expression (thus, a slash after them would be a
// regular expression).
//
// `isLoop` marks a keyword as starting a loop, which is important
// to know when parsing a label, in order to allow or disallow
// continue jumps to that label.

var _break = {keyword: "break"}, _case = {keyword: "case", beforeExpr: true}, _catch = {keyword: "catch"};
var _continue = {keyword: "continue"}, _debugger = {keyword: "debugger"}, _default = {keyword: "default"};
var _do = {keyword: "do", isLoop: true}, _else = {keyword: "else", beforeExpr: true};
var _finally = {keyword: "finally"}, _for = {keyword: "for", isLoop: true}, _function = {keyword: "function"};
var _if = {keyword: "if"}, _return = {keyword: "return", beforeExpr: true}, _switch = {keyword: "switch"};
var _throw = {keyword: "throw", beforeExpr: true}, _try = {keyword: "try"}, _var = {keyword: "var"};
var _let = {keyword: "let"}, _const = {keyword: "const"};
var _while = {keyword: "while", isLoop: true}, _with = {keyword: "with"}, _new = {keyword: "new", beforeExpr: true};
var _this = {keyword: "this"};
var _class = {keyword: "class"}, _extends = {keyword: "extends", beforeExpr: true};
var _export = {keyword: "export"}, _import = {keyword: "import"};
var _yield = {keyword: "yield", beforeExpr: true};

// The keywords that denote values.

var _null = {keyword: "null", atomValue: null}, _true = {keyword: "true", atomValue: true};
var _false = {keyword: "false", atomValue: false};

// Some keywords are treated as regular operators. `in` sometimes
// (when parsing `for`) needs to be tested against specifically, so
// we assign a variable name to it for quick comparing.

var _in = {keyword: "in", binop: 7, beforeExpr: true};

// Map keyword names to token types.

var keywordTypes = {"break": _break, "case": _case, "catch": _catch,
					"continue": _continue, "debugger": _debugger, "default": _default,
					"do": _do, "else": _else, "finally": _finally, "for": _for,
					"function": _function, "if": _if, "return": _return, "switch": _switch,
					"throw": _throw, "try": _try, "var": _var, "let": _let, "const": _const,
					"while": _while, "with": _with,
					"null": _null, "true": _true, "false": _false, "new": _new, "in": _in,
					"instanceof": {keyword: "instanceof", binop: 7, beforeExpr: true}, "this": _this,
					"typeof": {keyword: "typeof", prefix: true, beforeExpr: true},
					"void": {keyword: "void", prefix: true, beforeExpr: true},
					"delete": {keyword: "delete", prefix: true, beforeExpr: true},
					"class": _class, "extends": _extends,
					"export": _export, "import": _import, "yield": _yield};

// Punctuation token types. Again, the `type` property is purely for debugging.

var _bracketL = {type: "[", beforeExpr: true}, _bracketR = {type: "]"}, _braceL = {type: "{", beforeExpr: true};
var _braceR = {type: "}"}, _parenL = {type: "(", beforeExpr: true}, _parenR = {type: ")"};
var _comma = {type: ",", beforeExpr: true}, _semi = {type: ";", beforeExpr: true};
var _colon = {type: ":", beforeExpr: true}, _dot = {type: "."}, _ellipsis = {type: "..."}, _question = {type: "?", beforeExpr: true};
var _arrow = {type: "=>", beforeExpr: true}, _bquote = {type: "`"}, _dollarBraceL = {type: "${", beforeExpr: true};

// Operators. These carry several kinds of properties to help the
// parser use them properly (the presence of these properties is
// what categorizes them as operators).
//
// `binop`, when present, specifies that this operator is a binary
// operator, and will refer to its precedence.
//
// `prefix` and `postfix` mark the operator as a prefix or postfix
// unary operator. `isUpdate` specifies that the node produced by
// the operator should be of type UpdateExpression rather than
// simply UnaryExpression (`++` and `--`).
//
// `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
// binary operators with a very low precedence, that should result
// in AssignmentExpression nodes.

var _slash = {binop: 10, beforeExpr: true}, _eq = {isAssign: true, beforeExpr: true};
var _assign = {isAssign: true, beforeExpr: true};
var _incDec = {postfix: true, prefix: true, isUpdate: true}, _prefix = {prefix: true, beforeExpr: true};
var _logicalOR = {binop: 1, beforeExpr: true};
var _logicalAND = {binop: 2, beforeExpr: true};
var _bitwiseOR = {binop: 3, beforeExpr: true};
var _bitwiseXOR = {binop: 4, beforeExpr: true};
var _bitwiseAND = {binop: 5, beforeExpr: true};
var _equality = {binop: 6, beforeExpr: true};
var _relational = {binop: 7, beforeExpr: true};
var _bitShift = {binop: 8, beforeExpr: true};
var _plusMin = {binop: 9, prefix: true, beforeExpr: true};
var _modulo = {binop: 10, beforeExpr: true};

// '*' may be multiply or have special meaning in ES6
var _star = {binop: 10, beforeExpr: true};

// Provide access to the token types for external users of the
// tokenizer.

exports.tokTypes = {bracketL: _bracketL, bracketR: _bracketR, braceL: _braceL, braceR: _braceR,
					parenL: _parenL, parenR: _parenR, comma: _comma, semi: _semi, colon: _colon,
					dot: _dot, ellipsis: _ellipsis, question: _question, slash: _slash, eq: _eq,
					name: _name, eof: _eof, num: _num, regexp: _regexp, string: _string,
					arrow: _arrow, bquote: _bquote, dollarBraceL: _dollarBraceL};
for (var kw in keywordTypes) exports.tokTypes["_" + kw] = keywordTypes[kw];

// This is a trick taken from Esprima. It turns out that, on
// non-Chrome browsers, to check whether a string is in a set, a
// predicate containing a big ugly `switch` statement is faster than
// a regular expression, and on Chrome the two are about on par.
// This function uses `eval` (non-lexical) to produce such a
// predicate from a space-separated string of words.
//
// It starts by sorting the words by length.

function makePredicate(words) {
	words = words.split(" ");
	var f = "", cats = [];
	out: for (var i = 0; i < words.length; ++i) {
	for (var j = 0; j < cats.length; ++j)
		if (cats[j][0].length == words[i].length) {
		cats[j].push(words[i]);
		continue out;
		}
	cats.push([words[i]]);
	}
	function compareTo(arr) {
	if (arr.length == 1) return f += "return str === " + JSON.stringify(arr[0]) + ";";
	f += "switch(str){";
	for (var i = 0; i < arr.length; ++i) f += "case " + JSON.stringify(arr[i]) + ":";
	f += "return true}return false;";
	}

	// When there are more than three length categories, an outer
	// switch first dispatches on the lengths, to save on comparisons.

	if (cats.length > 3) {
	cats.sort(function(a, b) {return b.length - a.length;});
	f += "switch(str.length){";
	for (var i = 0; i < cats.length; ++i) {
		var cat = cats[i];
		f += "case " + cat[0].length + ":";
		compareTo(cat);
	}
	f += "}";

	// Otherwise, simply generate a flat `switch` statement.

	} else {
	compareTo(words);
	}
	return new Function("str", f);
}

// The ECMAScript 3 reserved word list.

var isReservedWord3 = makePredicate("abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile");

// ECMAScript 5 reserved words.

var isReservedWord5 = makePredicate("class enum extends super const export import");

// The additional reserved words in strict mode.

var isStrictReservedWord = makePredicate("implements interface let package private protected public static yield");

// The forbidden variable names in strict mode.

var isStrictBadIdWord = makePredicate("eval arguments");

// And the keywords.

var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";

var isEcma5AndLessKeyword = makePredicate(ecma5AndLessKeywords);

var isEcma6Keyword = makePredicate(ecma5AndLessKeywords + " let const class extends export import yield");

var isKeyword = isEcma5AndLessKeyword;

// ## Character categories

// Big ugly regular expressions that match characters in the
// whitespace, identifier, and identifier-start categories. These
// are only applied when a character is found to actually have a
// code point above 128.
// Generated by `tools/generate-identifier-regex.js`.

var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
var nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B2\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA7AD\uA7B0\uA7B1\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB5F\uAB64\uAB65\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
var nonASCIIidentifierChars = "\u0300-\u036F\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08E4-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0D01-\u0D03\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D82\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19B0-\u19C0\u19C8\u19C9\u19D0-\u19D9\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF2-\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF5\u1DFC-\u1DFF\u200C\u200D\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\uA620-\uA629\uA66F\uA674-\uA67D\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA880\uA881\uA8B4-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F1\uA900-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2D\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F";
var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

// Whether a single character denotes a newline.

var newline = /[\n\r\u2028\u2029]/;

// Matches a whole line break (where CRLF is considered a single
// line break). Used to count lines.

var lineBreak = /\r\n|[\n\r\u2028\u2029]/g;

// Test whether a given character code starts an identifier.

var isIdentifierStart = exports.isIdentifierStart = function(code) {
	if (code < 65) return code === 36;
	if (code < 91) return true;
	if (code < 97) return code === 95;
	if (code < 123)return true;
	return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));
};

// Test whether a given character is part of an identifier.

var isIdentifierChar = exports.isIdentifierChar = function(code) {
	if (code < 48) return code === 36;
	if (code < 58) return true;
	if (code < 65) return false;
	if (code < 91) return true;
	if (code < 97) return code === 95;
	if (code < 123)return true;
	return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
};

// ## Tokenizer

// These are used when `options.locations` is on, for the
// `tokStartLoc` and `tokEndLoc` properties.

function Position() {
	this.line = tokCurLine;
	this.column = tokPos - tokLineStart;
}

// Reset the token state. Used at the start of a parse.

function initTokenState() {
	tokCurLine = 1;
	tokPos = tokLineStart = 0;
	tokRegexpAllowed = true;
	metParenL = 0;
	inTemplate = false;
	skipSpace();
}

// Called at the end of every token. Sets `tokEnd`, `tokVal`, and
// `tokRegexpAllowed`, and skips the space after the token, so that
// the next one's `tokStart` will point at the right position.

function finishToken(type, val, shouldSkipSpace) {
	tokEnd = tokPos;
	if (options.locations) tokEndLoc = new Position;
	tokType = type;
	if (shouldSkipSpace !== false) skipSpace();
	tokVal = val;
	tokRegexpAllowed = type.beforeExpr;
	if (options.onToken) {
	options.onToken(getCurrentToken());
	}
}

function skipBlockComment() {
	var startLoc = options.onComment && options.locations && new Position;
	var start = tokPos, end = input.indexOf("*/", tokPos += 2);
	if (end === -1) raise(tokPos - 2, "Unterminated comment");
	tokPos = end + 2;
	if (options.locations) {
	lineBreak.lastIndex = start;
	var match;
	while ((match = lineBreak.exec(input)) && match.index < tokPos) {
		++tokCurLine;
		tokLineStart = match.index + match[0].length;
	}
	}
	if (options.onComment)
	options.onComment(true, input.slice(start + 2, end), start, tokPos,
						startLoc, options.locations && new Position);
}

function skipLineComment() {
	var start = tokPos;
	var startLoc = options.onComment && options.locations && new Position;
	var ch = input.charCodeAt(tokPos+=2);
	while (tokPos < inputLen && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
	++tokPos;
	ch = input.charCodeAt(tokPos);
	}
	if (options.onComment)
	options.onComment(false, input.slice(start + 2, tokPos), start, tokPos,
						startLoc, options.locations && new Position);
}

// Called at the start of the parse and after every token. Skips
// whitespace and comments, and.

function skipSpace() {
	while (tokPos < inputLen) {
	var ch = input.charCodeAt(tokPos);
	if (ch === 32) { // ' '
		++tokPos;
	} else if (ch === 13) {
		++tokPos;
		var next = input.charCodeAt(tokPos);
		if (next === 10) {
		++tokPos;
		}
		if (options.locations) {
		++tokCurLine;
		tokLineStart = tokPos;
		}
	} else if (ch === 10 || ch === 8232 || ch === 8233) {
		++tokPos;
		if (options.locations) {
		++tokCurLine;
		tokLineStart = tokPos;
		}
	} else if (ch > 8 && ch < 14) {
		++tokPos;
	} else if (ch === 47) { // '/'
		var next = input.charCodeAt(tokPos + 1);
		if (next === 42) { // '*'
		skipBlockComment();
		} else if (next === 47) { // '/'
		skipLineComment();
		} else break;
	} else if (ch === 160) { // '\xa0'
		++tokPos;
	} else if (ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
		++tokPos;
	} else {
		break;
	}
	}
}

// ### Token reading

// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
// The `forceRegexp` parameter is used in the one case where the
// `tokRegexpAllowed` trick does not work. See `parseStatement`.

function readToken_dot() {
	var next = input.charCodeAt(tokPos + 1);
	if (next >= 48 && next <= 57) return readNumber(true);
	var next2 = input.charCodeAt(tokPos + 2);
	if (options.ecmaVersion >= 6 && next === 46 && next2 === 46) { // 46 = dot '.'
	tokPos += 3;
	return finishToken(_ellipsis);
	} else {
	++tokPos;
	return finishToken(_dot);
	}
}

function readToken_slash() { // '/'
	var next = input.charCodeAt(tokPos + 1);
	if (tokRegexpAllowed) {++tokPos; return readRegexp();}
	if (next === 61) return finishOp(_assign, 2);
	return finishOp(_slash, 1);
}

function readToken_mult_modulo(code) { // '%*'
	var next = input.charCodeAt(tokPos + 1);
	if (next === 61) return finishOp(_assign, 2);
	return finishOp(code === 42 ? _star : _modulo, 1);
}

function readToken_pipe_amp(code) { // '|&'
	var next = input.charCodeAt(tokPos + 1);
	if (next === code) return finishOp(code === 124 ? _logicalOR : _logicalAND, 2);
	if (next === 61) return finishOp(_assign, 2);
	return finishOp(code === 124 ? _bitwiseOR : _bitwiseAND, 1);
}

function readToken_caret() { // '^'
	var next = input.charCodeAt(tokPos + 1);
	if (next === 61) return finishOp(_assign, 2);
	return finishOp(_bitwiseXOR, 1);
}

function readToken_plus_min(code) { // '+-'
	var next = input.charCodeAt(tokPos + 1);
	if (next === code) {
	if (next == 45 && input.charCodeAt(tokPos + 2) == 62 &&
		newline.test(input.slice(lastEnd, tokPos))) {
		// A `-->` line comment
		tokPos += 3;
		skipLineComment();
		skipSpace();
		return readToken();
	}
	return finishOp(_incDec, 2);
	}
	if (next === 61) return finishOp(_assign, 2);
	return finishOp(_plusMin, 1);
}

function readToken_lt_gt(code) { // '<>'
	var next = input.charCodeAt(tokPos + 1);
	var size = 1;
	if (next === code) {
	size = code === 62 && input.charCodeAt(tokPos + 2) === 62 ? 3 : 2;
	if (input.charCodeAt(tokPos + size) === 61) return finishOp(_assign, size + 1);
	return finishOp(_bitShift, size);
	}
	if (next == 33 && code == 60 && input.charCodeAt(tokPos + 2) == 45 &&
		input.charCodeAt(tokPos + 3) == 45) {
	// `<!--`, an XML-style comment that should be interpreted as a line comment
	tokPos += 4;
	skipLineComment();
	skipSpace();
	return readToken();
	}
	if (next === 61)
	size = input.charCodeAt(tokPos + 2) === 61 ? 3 : 2;
	return finishOp(_relational, size);
}

function readToken_eq_excl(code) { // '=!', '=>'
	var next = input.charCodeAt(tokPos + 1);
	if (next === 61) return finishOp(_equality, input.charCodeAt(tokPos + 2) === 61 ? 3 : 2);
	if (code === 61 && next === 62 && options.ecmaVersion >= 6) { // '=>'
	tokPos += 2;
	return finishToken(_arrow);
	}
	return finishOp(code === 61 ? _eq : _prefix, 1);
}

// Get token inside ES6 template (special rules work there).

function getTemplateToken(code) {
	// '`' and '${' have special meanings, but they should follow
	// string (can be empty)
	if (tokType === _string) {
	if (code === 96) { // '`'
		++tokPos;
		return finishToken(_bquote);
	} else
	if (code === 36 && input.charCodeAt(tokPos + 1) === 123) { // '${'
		tokPos += 2;
		return finishToken(_dollarBraceL);
	}
	}

	if (code === 125) { // '}'
	++tokPos;
	return finishToken(_braceR, undefined, false);
	}

	// anything else is considered string literal
	return readTmplString();
}

function getTokenFromCode(code) {
	switch (code) {
	// The interpretation of a dot depends on whether it is followed
	// by a digit or another two dots.
	case 46: // '.'
	return readToken_dot();

	// Punctuation tokens.
	case 40: ++tokPos; return finishToken(_parenL);
	case 41: ++tokPos; return finishToken(_parenR);
	case 59: ++tokPos; return finishToken(_semi);
	case 44: ++tokPos; return finishToken(_comma);
	case 91: ++tokPos; return finishToken(_bracketL);
	case 93: ++tokPos; return finishToken(_bracketR);
	case 123: ++tokPos; return finishToken(_braceL);
	case 125: ++tokPos; return finishToken(_braceR);
	case 58: ++tokPos; return finishToken(_colon);
	case 63: ++tokPos; return finishToken(_question);

	case 96: // '`'
	if (options.ecmaVersion >= 6) {
		++tokPos;
		return finishToken(_bquote, undefined, false);
	}

	case 48: // '0'
	var next = input.charCodeAt(tokPos + 1);
	if (next === 120 || next === 88) return readRadixNumber(16); // '0x', '0X' - hex number
	if (options.ecmaVersion >= 6) {
		if (next === 111 || next === 79) return readRadixNumber(8); // '0o', '0O' - octal number
		if (next === 98 || next === 66) return readRadixNumber(2); // '0b', '0B' - binary number
	}
	// Anything else beginning with a digit is an integer, octal
	// number, or float.
	case 49: case 50: case 51: case 52: case 53: case 54: case 55: case 56: case 57: // 1-9
	return readNumber(false);

	// Quotes produce strings.
	case 34: case 39: // '"', "'"
	return readString(code);

	// Operators are parsed inline in tiny state machines. '=' (61) is
	// often referred to. `finishOp` simply skips the amount of
	// characters it is given as second argument, and returns a token
	// of the type given by its first argument.

	case 47: // '/'
	return readToken_slash();

	case 37: case 42: // '%*'
	return readToken_mult_modulo(code);

	case 124: case 38: // '|&'
	return readToken_pipe_amp(code);

	case 94: // '^'
	return readToken_caret();

	case 43: case 45: // '+-'
	return readToken_plus_min(code);

	case 60: case 62: // '<>'
	return readToken_lt_gt(code);

	case 61: case 33: // '=!'
	return readToken_eq_excl(code);

	case 126: // '~'
	return finishOp(_prefix, 1);
	}

	return false;
}

function readToken(forceRegexp) {
	if (!forceRegexp) tokStart = tokPos;
	else tokPos = tokStart + 1;
	if (options.locations) tokStartLoc = new Position;
	if (forceRegexp) return readRegexp();
	if (tokPos >= inputLen) return finishToken(_eof);

	var code = input.charCodeAt(tokPos);

	if (inTemplate) return getTemplateToken(code);

	// Identifier or keyword. '\uXXXX' sequences are allowed in
	// identifiers, so '\' also dispatches to that.
	if (isIdentifierStart(code) || code === 92 /* '\' */) return readWord();

	var tok = getTokenFromCode(code);

	if (tok === false) {
	// If we are here, we either found a non-ASCII identifier
	// character, or something that's entirely disallowed.
	var ch = String.fromCharCode(code);
	if (ch === "\\" || nonASCIIidentifierStart.test(ch)) return readWord();
	raise(tokPos, "Unexpected character '" + ch + "'");
	}
	return tok;
}

function finishOp(type, size) {
	var str = input.slice(tokPos, tokPos + size);
	tokPos += size;
	finishToken(type, str);
}

// Parse a regular expression. Some context-awareness is necessary,
// since a '/' inside a '[]' set does not end the expression.

function readRegexp() {
	var content = "", escaped, inClass, start = tokPos;
	for (;;) {
	if (tokPos >= inputLen) raise(start, "Unterminated regular expression");
	var ch = input.charAt(tokPos);
	if (newline.test(ch)) raise(start, "Unterminated regular expression");
	if (!escaped) {
		if (ch === "[") inClass = true;
		else if (ch === "]" && inClass) inClass = false;
		else if (ch === "/" && !inClass) break;
		escaped = ch === "\\";
	} else escaped = false;
	++tokPos;
	}
	var content = input.slice(start, tokPos);
	++tokPos;
	// Need to use `readWord1` because '\uXXXX' sequences are allowed
	// here (don't ask).
	var mods = readWord1();
	if (mods && !/^[gmsiy]*$/.test(mods)) raise(start, "Invalid regular expression flag");
	try {
	var value = new RegExp(content, mods);
	} catch (e) {
	if (e instanceof SyntaxError) raise(start, "Error parsing regular expression: " + e.message);
	raise(e);
	}
	return finishToken(_regexp, value);
}

// Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.

function readInt(radix, len) {
	var start = tokPos, total = 0;
	for (var i = 0, e = len == null ? Infinity : len; i < e; ++i) {
	var code = input.charCodeAt(tokPos), val;
	if (code >= 97) val = code - 97 + 10; // a
	else if (code >= 65) val = code - 65 + 10; // A
	else if (code >= 48 && code <= 57) val = code - 48; // 0-9
	else val = Infinity;
	if (val >= radix) break;
	++tokPos;
	total = total * radix + val;
	}
	if (tokPos === start || len != null && tokPos - start !== len) return null;

	return total;
}

function readRadixNumber(radix) {
	tokPos += 2; // 0x
	var val = readInt(radix);
	if (val == null) raise(tokStart + 2, "Expected number in radix " + radix);
	if (isIdentifierStart(input.charCodeAt(tokPos))) raise(tokPos, "Identifier directly after number");
	return finishToken(_num, val);
}

// Read an integer, octal integer, or floating-point number.

function readNumber(startsWithDot) {
	var start = tokPos, isFloat = false, octal = input.charCodeAt(tokPos) === 48;
	if (!startsWithDot && readInt(10) === null) raise(start, "Invalid number");
	if (input.charCodeAt(tokPos) === 46) {
	++tokPos;
	readInt(10);
	isFloat = true;
	}
	var next = input.charCodeAt(tokPos);
	if (next === 69 || next === 101) { // 'eE'
	next = input.charCodeAt(++tokPos);
	if (next === 43 || next === 45) ++tokPos; // '+-'
	if (readInt(10) === null) raise(start, "Invalid number");
	isFloat = true;
	}
	if (isIdentifierStart(input.charCodeAt(tokPos))) raise(tokPos, "Identifier directly after number");

	var str = input.slice(start, tokPos), val;
	if (isFloat) val = parseFloat(str);
	else if (!octal || str.length === 1) val = parseInt(str, 10);
	else if (/[89]/.test(str) || strict) raise(start, "Invalid number");
	else val = parseInt(str, 8);
	return finishToken(_num, val);
}

// Read a string value, interpreting backslash-escapes.

function readCodePoint() {
	var ch = input.charCodeAt(tokPos), code;

	if (ch === 123) {
	if (options.ecmaVersion < 6) unexpected();
	++tokPos;
	code = readHexChar(input.indexOf('}', tokPos) - tokPos);
	++tokPos;
	if (code > 0x10FFFF) unexpected();
	} else {
	code = readHexChar(4);
	}

	// UTF-16 Encoding
	if (code <= 0xFFFF) {
	return String.fromCharCode(code);
	}
	var cu1 = ((code - 0x10000) >> 10) + 0xD800;
	var cu2 = ((code - 0x10000) & 1023) + 0xDC00;
	return String.fromCharCode(cu1, cu2);
}

function readString(quote) {
	++tokPos;
	var out = "";
	for (;;) {
	if (tokPos >= inputLen) raise(tokStart, "Unterminated string constant");
	var ch = input.charCodeAt(tokPos);
	if (ch === quote) {
		++tokPos;
		return finishToken(_string, out);
	}
	if (ch === 92) { // '\'
		out += readEscapedChar();
	} else {
		++tokPos;
		if (newline.test(String.fromCharCode(ch))) {
		raise(tokStart, "Unterminated string constant");
		}
		out += String.fromCharCode(ch); // '\'
	}
	}
}

function readTmplString() {
	var out = "";
	for (;;) {
	if (tokPos >= inputLen) raise(tokStart, "Unterminated string constant");
	var ch = input.charCodeAt(tokPos);
	if (ch === 96 || ch === 36 && input.charCodeAt(tokPos + 1) === 123) // '`', '${'
		return finishToken(_string, out);
	if (ch === 92) { // '\'
		out += readEscapedChar();
	} else {
		++tokPos;
		if (newline.test(String.fromCharCode(ch))) {
		if (ch === 13 && input.charCodeAt(tokPos) === 10) {
			++tokPos;
			ch = 10;
		}
		if (options.locations) {
			++tokCurLine;
			tokLineStart = tokPos;
		}
		}
		out += String.fromCharCode(ch); // '\'
	}
	}
}

// Used to read escaped characters

function readEscapedChar() {
	var ch = input.charCodeAt(++tokPos);
	var octal = /^[0-7]+/.exec(input.slice(tokPos, tokPos + 3));
	if (octal) octal = octal[0];
	while (octal && parseInt(octal, 8) > 255) octal = octal.slice(0, -1);
	if (octal === "0") octal = null;
	++tokPos;
	if (octal) {
	if (strict) raise(tokPos - 2, "Octal literal in strict mode");
	tokPos += octal.length - 1;
	return String.fromCharCode(parseInt(octal, 8));
	} else {
	switch (ch) {
		case 110: return "\n"; // 'n' -> '\n'
		case 114: return "\r"; // 'r' -> '\r'
		case 120: return String.fromCharCode(readHexChar(2)); // 'x'
		case 117: return readCodePoint(); // 'u'
		case 85: return String.fromCharCode(readHexChar(8)); // 'U'
		case 116: return "\t"; // 't' -> '\t'
		case 98: return "\b"; // 'b' -> '\b'
		case 118: return "\u000b"; // 'v' -> '\u000b'
		case 102: return "\f"; // 'f' -> '\f'
		case 48: return "\0"; // 0 -> '\0'
		case 13: if (input.charCodeAt(tokPos) === 10) ++tokPos; // '\r\n'
		case 10: // ' \n'
		if (options.locations) { tokLineStart = tokPos; ++tokCurLine; }
		return "";
		default: return String.fromCharCode(ch);
	}
	}
}

// Used to read character escape sequences ('\x', '\u', '\U').

function readHexChar(len) {
	var n = readInt(16, len);
	if (n === null) raise(tokStart, "Bad character escape sequence");
	return n;
}

// Used to signal to callers of `readWord1` whether the word
// contained any escape sequences. This is needed because words with
// escape sequences must not be interpreted as keywords.

var containsEsc;

// Read an identifier, and return it as a string. Sets `containsEsc`
// to whether the word contained a '\u' escape.
//
// Only builds up the word character-by-character when it actually
// containeds an escape, as a micro-optimization.

function readWord1() {
	containsEsc = false;
	var word, first = true, start = tokPos;
	for (;;) {
	var ch = input.charCodeAt(tokPos);
	if (isIdentifierChar(ch)) {
		if (containsEsc) word += input.charAt(tokPos);
		++tokPos;
	} else if (ch === 92) { // "\"
		if (!containsEsc) word = input.slice(start, tokPos);
		containsEsc = true;
		if (input.charCodeAt(++tokPos) != 117) // "u"
		raise(tokPos, "Expecting Unicode escape sequence \\uXXXX");
		++tokPos;
		var esc = readHexChar(4);
		var escStr = String.fromCharCode(esc);
		if (!escStr) raise(tokPos - 1, "Invalid Unicode escape");
		if (!(first ? isIdentifierStart(esc) : isIdentifierChar(esc)))
		raise(tokPos - 4, "Invalid Unicode escape");
		word += escStr;
	} else {
		break;
	}
	first = false;
	}
	return containsEsc ? word : input.slice(start, tokPos);
}

// Read an identifier or keyword token. Will check for reserved
// words when necessary.

function readWord() {
	var word = readWord1();
	var type = _name;
	if (!containsEsc && isKeyword(word))
	type = keywordTypes[word];
	return finishToken(type, word);
}

// ## Parser

// A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

// ### Parser utilities

// Continue to the next token.

function next() {
	lastStart = tokStart;
	lastEnd = tokEnd;
	lastEndLoc = tokEndLoc;
	readToken();
}

// Enter strict mode. Re-reads the next token to please pedantic
// tests ("use strict"; 010; -- should fail).

function setStrict(strct) {
	strict = strct;
	tokPos = tokStart;
	if (options.locations) {
	while (tokPos < tokLineStart) {
		tokLineStart = input.lastIndexOf("\n", tokLineStart - 2) + 1;
		--tokCurLine;
	}
	}
	skipSpace();
	readToken();
}

// Start an AST node, attaching a start offset.

function Node() {
	this.type = null;
	this.start = tokStart;
	this.end = null;
}

exports.Node = Node;

function SourceLocation() {
	this.start = tokStartLoc;
	this.end = null;
	if (sourceFile !== null) this.source = sourceFile;
}

function startNode() {
	var node = new Node();
	if (options.locations)
	node.loc = new SourceLocation();
	if (options.directSourceFile)
	node.sourceFile = options.directSourceFile;
	if (options.ranges)
	node.range = [tokStart, 0];
	return node;
}

// Start a node whose start offset information should be based on
// the start of another node. For example, a binary operator node is
// only started after its left-hand side has already been parsed.

function startNodeFrom(other) {
	var node = new Node();
	node.start = other.start;
	if (options.locations) {
	node.loc = new SourceLocation();
	node.loc.start = other.loc.start;
	}
	if (options.ranges)
	node.range = [other.range[0], 0];

	return node;
}

// Finish an AST node, adding `type` and `end` properties.

function finishNode(node, type) {
	node.type = type;
	node.end = lastEnd;
	if (options.locations)
	node.loc.end = lastEndLoc;
	if (options.ranges)
	node.range[1] = lastEnd;
	return node;
}

// Test whether a statement node is the string literal `"use strict"`.

function isUseStrict(stmt) {
	return options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" &&
	stmt.expression.type === "Literal" && stmt.expression.value === "use strict";
}

// Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.

function eat(type) {
	if (tokType === type) {
	next();
	return true;
	} else {
	return false;
	}
}

// Test whether a semicolon can be inserted at the current position.

function canInsertSemicolon() {
	return !options.strictSemicolons &&
	(tokType === _eof || tokType === _braceR || newline.test(input.slice(lastEnd, tokStart)));
}

// Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.

function semicolon() {
	if (!eat(_semi) && !canInsertSemicolon()) unexpected();
}

// Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error.

function expect(type) {
	eat(type) || unexpected();
}

// Raise an unexpected token error.

function unexpected(pos) {
	raise(pos != null ? pos : tokStart, "Unexpected token");
}

// Checks if hash object has a property.

function has(obj, propName) {
	return Object.prototype.hasOwnProperty.call(obj, propName);
}
// Convert existing expression atom to assignable pattern
// if possible.

function toAssignable(node, allowSpread, checkType) {
	if (options.ecmaVersion >= 6 && node) {
	switch (node.type) {
		case "Identifier":
		case "MemberExpression":
		break;

		case "ObjectExpression":
		node.type = "ObjectPattern";
		for (var i = 0; i < node.properties.length; i++) {
			var prop = node.properties[i];
			if (prop.kind !== "init") unexpected(prop.key.start);
			toAssignable(prop.value, false, checkType);
		}
		break;

		case "ArrayExpression":
		node.type = "ArrayPattern";
		for (var i = 0, lastI = node.elements.length - 1; i <= lastI; i++) {
			toAssignable(node.elements[i], i === lastI, checkType);
		}
		break;

		case "SpreadElement":
		if (allowSpread) {
			toAssignable(node.argument, false, checkType);
			checkSpreadAssign(node.argument);
		} else {
			unexpected(node.start);
		}
		break;

		default:
		if (checkType) unexpected(node.start);
	}
	}
	return node;
}

// Checks if node can be assignable spread argument.

function checkSpreadAssign(node) {
	if (node.type !== "Identifier" && node.type !== "ArrayPattern")
	unexpected(node.start);
}

// Verify that argument names are not repeated, and it does not
// try to bind the words `eval` or `arguments`.

function checkFunctionParam(param, nameHash) {
	switch (param.type) {
	case "Identifier":
		if (isStrictReservedWord(param.name) || isStrictBadIdWord(param.name))
		raise(param.start, "Defining '" + param.name + "' in strict mode");
		if (has(nameHash, param.name))
		raise(param.start, "Argument name clash in strict mode");
		nameHash[param.name] = true;
		break;

	case "ObjectPattern":
		for (var i = 0; i < param.properties.length; i++)
		checkFunctionParam(param.properties[i].value, nameHash);
		break;

	case "ArrayPattern":
		for (var i = 0; i < param.elements.length; i++)
		checkFunctionParam(param.elements[i], nameHash);
		break;
	}
}

// Check if property name clashes with already added.
// Object/class getters and setters are not allowed to clash —
// either with each other or with an init property — and in
// strict mode, init properties are also not allowed to be repeated.

function checkPropClash(prop, propHash) {
	if (prop.computed) return;
	var key = prop.key, name;
	switch (key.type) {
	case "Identifier": name = key.name; break;
	case "Literal": name = String(key.value); break;
	default: return;
	}
	var kind = prop.kind || "init", other;
	if (has(propHash, name)) {
	other = propHash[name];
	var isGetSet = kind !== "init";
	if ((strict || isGetSet) && other[kind] || !(isGetSet ^ other.init))
		raise(key.start, "Redefinition of property");
	} else {
	other = propHash[name] = {
		init: false,
		get: false,
		set: false
	};
	}
	other[kind] = true;
}

// Verify that a node is an lval — something that can be assigned
// to.

function checkLVal(expr, isBinding) {
	switch (expr.type) {
	case "Identifier":
		if (strict && (isStrictBadIdWord(expr.name) || isStrictReservedWord(expr.name)))
		raise(expr.start, isBinding
			? "Binding " + expr.name + " in strict mode"
			: "Assigning to " + expr.name + " in strict mode"
		);
		break;

	case "MemberExpression":
		if (!isBinding) break;

	case "ObjectPattern":
		for (var i = 0; i < expr.properties.length; i++)
		checkLVal(expr.properties[i].value, isBinding);
		break;

	case "ArrayPattern":
		for (var i = 0; i < expr.elements.length; i++) {
		var elem = expr.elements[i];
		if (elem) checkLVal(elem, isBinding);
		}
		break;

	case "SpreadElement":
		break;

	default:
		raise(expr.start, "Assigning to rvalue");
	}
}

// ### Statement parsing

// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.  Optionally takes a
// `program` argument.  If present, the statements will be appended
// to its body instead of creating a new node.

function parseTopLevel(program) {
	lastStart = lastEnd = tokPos;
	if (options.locations) lastEndLoc = new Position;
	inFunction = inGenerator = strict = null;
	labels = [];
	readToken();

	var node = program || startNode(), first = true;
	if (!program) node.body = [];
	while (tokType !== _eof) {
	var stmt = parseStatement();
	node.body.push(stmt);
	if (first && isUseStrict(stmt)) setStrict(true);
	first = false;
	}
	return finishNode(node, "Program");
}

var loopLabel = {kind: "loop"}, switchLabel = {kind: "switch"};

// Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo);`, where looking at the previous token
// does not help.

function parseStatement() {
	if (tokType === _slash || tokType === _assign && tokVal == "/=")
	readToken(true);

	var starttype = tokType, node = startNode();

	// Most types of statements are recognized by the keyword they
	// start with. Many are trivial to parse, some require a bit of
	// complexity.

	switch (starttype) {
	case _break: case _continue: return parseBreakContinueStatement(node, starttype.keyword);
	case _debugger: return parseDebuggerStatement(node);
	case _do: return parseDoStatement(node);
	case _for: return parseForStatement(node);
	case _function: return parseFunctionStatement(node);
	case _class: return parseClass(node, true);
	case _if: return parseIfStatement(node);
	case _return: return parseReturnStatement(node);
	case _switch: return parseSwitchStatement(node);
	case _throw: return parseThrowStatement(node);
	case _try: return parseTryStatement(node);
	case _var: case _let: case _const: return parseVarStatement(node, starttype.keyword);
	case _while: return parseWhileStatement(node);
	case _with: return parseWithStatement(node);
	case _braceL: return parseBlock(); // no point creating a function for this
	case _semi: return parseEmptyStatement(node);
	case _export: return parseExport(node);
	case _import: return parseImport(node);

	// If the statement does not start with a statement keyword or a
	// brace, it's an ExpressionStatement or LabeledStatement. We
	// simply start parsing an expression, and afterwards, if the
	// next token is a colon and the expression was a simple
	// Identifier node, we switch to interpreting it as a label.
	default:
	var maybeName = tokVal, expr = parseExpression();
	if (starttype === _name && expr.type === "Identifier" && eat(_colon))
		return parseLabeledStatement(node, maybeName, expr);
	else return parseExpressionStatement(node, expr);
	}
}

function parseBreakContinueStatement(node, keyword) {
	var isBreak = keyword == "break";
	next();
	if (eat(_semi) || canInsertSemicolon()) node.label = null;
	else if (tokType !== _name) unexpected();
	else {
	node.label = parseIdent();
	semicolon();
	}

	// Verify that there is an actual destination to break or
	// continue to.
	for (var i = 0; i < labels.length; ++i) {
	var lab = labels[i];
	if (node.label == null || lab.name === node.label.name) {
		if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
		if (node.label && isBreak) break;
	}
	}
	if (i === labels.length) raise(node.start, "Unsyntactic " + keyword);
	return finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
}

function parseDebuggerStatement(node) {
	next();
	semicolon();
	return finishNode(node, "DebuggerStatement");
}

function parseDoStatement(node) {
	next();
	labels.push(loopLabel);
	node.body = parseStatement();
	labels.pop();
	expect(_while);
	node.test = parseParenExpression();
	semicolon();
	return finishNode(node, "DoWhileStatement");
}

// Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.

function parseForStatement(node) {
	next();
	labels.push(loopLabel);
	expect(_parenL);
	if (tokType === _semi) return parseFor(node, null);
	if (tokType === _var || tokType === _let) {
	var init = startNode(), varKind = tokType.keyword, isLet = tokType === _let;
	next();
	parseVar(init, true, varKind);
	finishNode(init, "VariableDeclaration");
	if ((tokType === _in || (tokType === _name && tokVal === "of")) && init.declarations.length === 1 &&
		!(isLet && init.declarations[0].init))
		return parseForIn(node, init);
	return parseFor(node, init);
	}
	var init = parseExpression(false, true);
	if (tokType === _in || (tokType === _name && tokVal === "of")) {
	checkLVal(init);
	return parseForIn(node, init);
	}
	return parseFor(node, init);
}

function parseFunctionStatement(node) {
	next();
	return parseFunction(node, true);
}

function parseIfStatement(node) {
	next();
	node.test = parseParenExpression();
	node.consequent = parseStatement();
	node.alternate = eat(_else) ? parseStatement() : null;
	return finishNode(node, "IfStatement");
}

function parseReturnStatement(node) {
	if (!inFunction && !options.allowReturnOutsideFunction)
	raise(tokStart, "'return' outside of function");
	next();

	// In `return` (and `break`/`continue`), the keywords with
	// optional arguments, we eagerly look for a semicolon or the
	// possibility to insert one.

	if (eat(_semi) || canInsertSemicolon()) node.argument = null;
	else { node.argument = parseExpression(); semicolon(); }
	return finishNode(node, "ReturnStatement");
}

function parseSwitchStatement(node) {
	next();
	node.discriminant = parseParenExpression();
	node.cases = [];
	expect(_braceL);
	labels.push(switchLabel);

	// Statements under must be grouped (by label) in SwitchCase
	// nodes. `cur` is used to keep the node that we are currently
	// adding statements to.

	for (var cur, sawDefault; tokType != _braceR;) {
	if (tokType === _case || tokType === _default) {
		var isCase = tokType === _case;
		if (cur) finishNode(cur, "SwitchCase");
		node.cases.push(cur = startNode());
		cur.consequent = [];
		next();
		if (isCase) cur.test = parseExpression();
		else {
		if (sawDefault) raise(lastStart, "Multiple default clauses"); sawDefault = true;
		cur.test = null;
		}
		expect(_colon);
	} else {
		if (!cur) unexpected();
		cur.consequent.push(parseStatement());
	}
	}
	if (cur) finishNode(cur, "SwitchCase");
	next(); // Closing brace
	labels.pop();
	return finishNode(node, "SwitchStatement");
}

function parseThrowStatement(node) {
	next();
	if (newline.test(input.slice(lastEnd, tokStart)))
	raise(lastEnd, "Illegal newline after throw");
	node.argument = parseExpression();
	semicolon();
	return finishNode(node, "ThrowStatement");
}

function parseTryStatement(node) {
	next();
	node.block = parseBlock();
	node.handler = null;
	if (tokType === _catch) {
	var clause = startNode();
	next();
	expect(_parenL);
	clause.param = parseIdent();
	if (strict && isStrictBadIdWord(clause.param.name))
		raise(clause.param.start, "Binding " + clause.param.name + " in strict mode");
	expect(_parenR);
	clause.guard = null;
	clause.body = parseBlock();
	node.handler = finishNode(clause, "CatchClause");
	}
	node.guardedHandlers = empty;
	node.finalizer = eat(_finally) ? parseBlock() : null;
	if (!node.handler && !node.finalizer)
	raise(node.start, "Missing catch or finally clause");
	return finishNode(node, "TryStatement");
}

function parseVarStatement(node, kind) {
	next();
	parseVar(node, false, kind);
	semicolon();
	return finishNode(node, "VariableDeclaration");
}

function parseWhileStatement(node) {
	next();
	node.test = parseParenExpression();
	labels.push(loopLabel);
	node.body = parseStatement();
	labels.pop();
	return finishNode(node, "WhileStatement");
}

function parseWithStatement(node) {
	if (strict) raise(tokStart, "'with' in strict mode");
	next();
	node.object = parseParenExpression();
	node.body = parseStatement();
	return finishNode(node, "WithStatement");
}

function parseEmptyStatement(node) {
	next();
	return finishNode(node, "EmptyStatement");
}

function parseLabeledStatement(node, maybeName, expr) {
	for (var i = 0; i < labels.length; ++i)
	if (labels[i].name === maybeName) raise(expr.start, "Label '" + maybeName + "' is already declared");
	var kind = tokType.isLoop ? "loop" : tokType === _switch ? "switch" : null;
	labels.push({name: maybeName, kind: kind});
	node.body = parseStatement();
	labels.pop();
	node.label = expr;
	return finishNode(node, "LabeledStatement");
}

function parseExpressionStatement(node, expr) {
	node.expression = expr;
	semicolon();
	return finishNode(node, "ExpressionStatement");
}

// Used for constructs like `switch` and `if` that insist on
// parentheses around their expression.

function parseParenExpression() {
	expect(_parenL);
	var val = parseExpression();
	expect(_parenR);
	return val;
}

// Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).

function parseBlock(allowStrict) {
	var node = startNode(), first = true, strict = false, oldStrict;
	node.body = [];
	expect(_braceL);
	while (!eat(_braceR)) {
	var stmt = parseStatement();
	node.body.push(stmt);
	if (first && allowStrict && isUseStrict(stmt)) {
		oldStrict = strict;
		setStrict(strict = true);
	}
	first = false;
	}
	if (strict && !oldStrict) setStrict(false);
	return finishNode(node, "BlockStatement");
}

// Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.

function parseFor(node, init) {
	node.init = init;
	expect(_semi);
	node.test = tokType === _semi ? null : parseExpression();
	expect(_semi);
	node.update = tokType === _parenR ? null : parseExpression();
	expect(_parenR);
	node.body = parseStatement();
	labels.pop();
	return finishNode(node, "ForStatement");
}

// Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.

function parseForIn(node, init) {
	var type = tokType === _in ? "ForInStatement" : "ForOfStatement";
	next();
	node.left = init;
	node.right = parseExpression();
	expect(_parenR);
	node.body = parseStatement();
	labels.pop();
	return finishNode(node, type);
}

// Parse a list of variable declarations.

function parseVar(node, noIn, kind) {
	node.declarations = [];
	node.kind = kind;
	for (;;) {
	var decl = startNode();
	decl.id = options.ecmaVersion >= 6 ? toAssignable(parseExprAtom()) : parseIdent();
	checkLVal(decl.id, true);
	decl.init = eat(_eq) ? parseExpression(true, noIn) : (kind === _const.keyword ? unexpected() : null);
	node.declarations.push(finishNode(decl, "VariableDeclarator"));
	if (!eat(_comma)) break;
	}
	return node;
}

// ### Expression parsing

// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function(s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.

// Parse a full expression. The arguments are used to forbid comma
// sequences (in argument lists, array literals, or object literals)
// or the `in` operator (in for loops initalization expressions).

function parseExpression(noComma, noIn) {
	var expr = parseMaybeAssign(noIn);
	if (!noComma && tokType === _comma) {
	var node = startNodeFrom(expr);
	node.expressions = [expr];
	while (eat(_comma)) node.expressions.push(parseMaybeAssign(noIn));
	return finishNode(node, "SequenceExpression");
	}
	return expr;
}

// Parse an assignment expression. This includes applications of
// operators like `+=`.

function parseMaybeAssign(noIn) {
	var left = parseMaybeConditional(noIn);
	if (tokType.isAssign) {
	var node = startNodeFrom(left);
	node.operator = tokVal;
	node.left = tokType === _eq ? toAssignable(left) : left;
	checkLVal(left);
	next();
	node.right = parseMaybeAssign(noIn);
	return finishNode(node, "AssignmentExpression");
	}
	return left;
}

// Parse a ternary conditional (`?:`) operator.

function parseMaybeConditional(noIn) {
	var expr = parseExprOps(noIn);
	if (eat(_question)) {
	var node = startNodeFrom(expr);
	node.test = expr;
	node.consequent = parseExpression(true);
	expect(_colon);
	node.alternate = parseExpression(true, noIn);
	return finishNode(node, "ConditionalExpression");
	}
	return expr;
}

// Start the precedence parser.

function parseExprOps(noIn) {
	return parseExprOp(parseMaybeUnary(), -1, noIn);
}

// Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.

function parseExprOp(left, minPrec, noIn) {
	var prec = tokType.binop;
	if (prec != null && (!noIn || tokType !== _in)) {
	if (prec > minPrec) {
		var node = startNodeFrom(left);
		node.left = left;
		node.operator = tokVal;
		var op = tokType;
		next();
		node.right = parseExprOp(parseMaybeUnary(), prec, noIn);
		var exprNode = finishNode(node, (op === _logicalOR || op === _logicalAND) ? "LogicalExpression" : "BinaryExpression");
		return parseExprOp(exprNode, minPrec, noIn);
	}
	}
	return left;
}

// Parse unary operators, both prefix and postfix.

function parseMaybeUnary() {
	if (tokType.prefix) {
	var node = startNode(), update = tokType.isUpdate;
	node.operator = tokVal;
	node.prefix = true;
	tokRegexpAllowed = true;
	next();
	node.argument = parseMaybeUnary();
	if (update) checkLVal(node.argument);
	else if (strict && node.operator === "delete" &&
			node.argument.type === "Identifier")
		raise(node.start, "Deleting local variable in strict mode");
	return finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
	}
	var expr = parseExprSubscripts();
	while (tokType.postfix && !canInsertSemicolon()) {
	var node = startNodeFrom(expr);
	node.operator = tokVal;
	node.prefix = false;
	node.argument = expr;
	checkLVal(expr);
	next();
	expr = finishNode(node, "UpdateExpression");
	}
	return expr;
}

// Parse call, dot, and `[]`-subscript expressions.

function parseExprSubscripts() {
	return parseSubscripts(parseExprAtom());
}

function parseSubscripts(base, noCalls) {
	if (eat(_dot)) {
	var node = startNodeFrom(base);
	node.object = base;
	node.property = parseIdent(true);
	node.computed = false;
	return parseSubscripts(finishNode(node, "MemberExpression"), noCalls);
	} else if (eat(_bracketL)) {
	var node = startNodeFrom(base);
	node.object = base;
	node.property = parseExpression();
	node.computed = true;
	expect(_bracketR);
	return parseSubscripts(finishNode(node, "MemberExpression"), noCalls);
	} else if (!noCalls && eat(_parenL)) {
	var node = startNodeFrom(base);
	node.callee = base;
	node.arguments = parseExprList(_parenR, false);
	return parseSubscripts(finishNode(node, "CallExpression"), noCalls);
	} else if (tokType === _bquote) {
	var node = startNodeFrom(base);
	node.tag = base;
	node.quasi = parseTemplate();
	return parseSubscripts(finishNode(node, "TaggedTemplateExpression"), noCalls);
	} return base;
}

// Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.

function parseExprAtom() {
	switch (tokType) {
	case _this:
	var node = startNode();
	next();
	return finishNode(node, "ThisExpression");

	case _yield:
	if (inGenerator) return parseYield();

	case _name:
	var id = parseIdent(tokType !== _name);
	if (eat(_arrow)) {
		return parseArrowExpression(startNodeFrom(id), [id]);
	}
	return id;

	case _num: case _string: case _regexp:
	var node = startNode();
	node.value = tokVal;
	node.raw = input.slice(tokStart, tokEnd);
	next();
	return finishNode(node, "Literal");

	case _null: case _true: case _false:
	var node = startNode();
	node.value = tokType.atomValue;
	node.raw = tokType.keyword;
	next();
	return finishNode(node, "Literal");

	case _parenL:
	var tokStartLoc1 = tokStartLoc, tokStart1 = tokStart, val, exprList;
	next();
	// check whether this is generator comprehension or regular expression
	if (options.ecmaVersion >= 6 && tokType === _for) {
		val = parseComprehension(startNode(), true);
	} else {
		var oldParenL = ++metParenL;
		if (tokType !== _parenR) {
		val = parseExpression();
		exprList = val.type === "SequenceExpression" ? val.expressions : [val];
		} else {
		exprList = [];
		}
		expect(_parenR);
		// if '=>' follows '(...)', convert contents to arguments
		if (metParenL === oldParenL && eat(_arrow)) {
		val = parseArrowExpression(startNode(), exprList);
		} else {
		// forbid '()' before everything but '=>'
		if (!val) unexpected(lastStart);
		// forbid '...' in sequence expressions
		if (options.ecmaVersion >= 6) {
			for (var i = 0; i < exprList.length; i++) {
			if (exprList[i].type === "SpreadElement") unexpected();
			}
		}
		}
	}
	val.start = tokStart1;
	val.end = lastEnd;
	if (options.locations) {
		val.loc.start = tokStartLoc1;
		val.loc.end = lastEndLoc;
	}
	if (options.ranges) {
		val.range = [tokStart1, lastEnd];
	}
	return val;

	case _bracketL:
	var node = startNode();
	next();
	// check whether this is array comprehension or regular array
	if (options.ecmaVersion >= 6 && tokType === _for) {
		return parseComprehension(node, false);
	}
	node.elements = parseExprList(_bracketR, true, true);
	return finishNode(node, "ArrayExpression");

	case _braceL:
	return parseObj();

	case _function:
	var node = startNode();
	next();
	return parseFunction(node, false);

	case _class:
	return parseClass(startNode(), false);

	case _new:
	return parseNew();

	case _ellipsis:
	return parseSpread();

	case _bquote:
	return parseTemplate();

	default:
	unexpected();
	}
}

// New's precedence is slightly tricky. It must allow its argument
// to be a `[]` or dot subscript expression, but not a call — at
// least, not without wrapping it in parentheses. Thus, it uses the

function parseNew() {
	var node = startNode();
	next();
	node.callee = parseSubscripts(parseExprAtom(), true);
	if (eat(_parenL)) node.arguments = parseExprList(_parenR, false);
	else node.arguments = empty;
	return finishNode(node, "NewExpression");
}

// Parse spread element '...expr'

function parseSpread() {
	var node = startNode();
	next();
	node.argument = parseExpression(true);
	return finishNode(node, "SpreadElement");
}

// Parse template expression.

function parseTemplate() {
	var node = startNode();
	node.expressions = [];
	node.quasis = [];
	inTemplate = true;
	next();
	for (;;) {
	var elem = startNode();
	elem.value = {cooked: tokVal, raw: input.slice(tokStart, tokEnd)};
	elem.tail = false;
	next();
	node.quasis.push(finishNode(elem, "TemplateElement"));
	if (eat(_bquote)) { // '`', end of template
		elem.tail = true;
		break;
	}
	inTemplate = false;
	expect(_dollarBraceL);
	node.expressions.push(parseExpression());
	inTemplate = true;
	expect(_braceR);
	}
	inTemplate = false;
	return finishNode(node, "TemplateLiteral");
}

// Parse an object literal.

function parseObj() {
	var node = startNode(), first = true, propHash = {};
	node.properties = [];
	next();
	while (!eat(_braceR)) {
	if (!first) {
		expect(_comma);
		if (options.allowTrailingCommas && eat(_braceR)) break;
	} else first = false;

	var prop = startNode(), kind, isGenerator;
	if (options.ecmaVersion >= 6) {
		prop.method = false;
		prop.shorthand = false;
		isGenerator = eat(_star);
	}
	parsePropertyName(prop);
	if (eat(_colon)) {
		prop.value = parseExpression(true);
		kind = prop.kind = "init";
	} else if (options.ecmaVersion >= 6 && tokType === _parenL) {
		kind = prop.kind = "init";
		prop.method = true;
		prop.value = parseMethod(isGenerator);
	} else if (options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" &&
				(prop.key.name === "get" || prop.key.name === "set")) {
		if (isGenerator) unexpected();
		kind = prop.kind = prop.key.name;
		parsePropertyName(prop);
		prop.value = parseMethod(false);
	} else if (options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
		kind = prop.kind = "init";
		prop.value = prop.key;
		prop.shorthand = true;
	} else unexpected();

	checkPropClash(prop, propHash);
	node.properties.push(finishNode(prop, "Property"));
	}
	return finishNode(node, "ObjectExpression");
}

function parsePropertyName(prop) {
	if (options.ecmaVersion >= 6) {
	if (eat(_bracketL)) {
		prop.computed = true;
		prop.key = parseExpression();
		expect(_bracketR);
		return;
	} else {
		prop.computed = false;
	}
	}
	prop.key = (tokType === _num || tokType === _string) ? parseExprAtom() : parseIdent(true);
}

// Initialize empty function node.

function initFunction(node) {
	node.id = null;
	node.params = [];
	if (options.ecmaVersion >= 6) {
	node.defaults = [];
	node.rest = null;
	node.generator = false;
	}
}

// Parse a function declaration or literal (depending on the
// `isStatement` parameter).

function parseFunction(node, isStatement, allowExpressionBody) {
	initFunction(node);
	if (options.ecmaVersion >= 6) {
	node.generator = eat(_star);
	}
	if (isStatement || tokType === _name) {
	node.id = parseIdent();
	}
	parseFunctionParams(node);
	parseFunctionBody(node, allowExpressionBody);
	return finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
}

// Parse object or class method.

function parseMethod(isGenerator) {
	var node = startNode();
	initFunction(node);
	parseFunctionParams(node);
	var allowExpressionBody;
	if (options.ecmaVersion >= 6) {
	node.generator = isGenerator;
	allowExpressionBody = true;
	} else {
	allowExpressionBody = false;
	}
	parseFunctionBody(node, allowExpressionBody);
	return finishNode(node, "FunctionExpression");
}

// Parse arrow function expression with given parameters.

function parseArrowExpression(node, params) {
	initFunction(node);

	var defaults = node.defaults, hasDefaults = false;

	for (var i = 0, lastI = params.length - 1; i <= lastI; i++) {
	var param = params[i];

	if (param.type === "AssignmentExpression" && param.operator === "=") {
		hasDefaults = true;
		params[i] = param.left;
		defaults.push(param.right);
	} else {
		toAssignable(param, i === lastI, true);
		defaults.push(null);
		if (param.type === "SpreadElement") {
		params.length--;
		node.rest = param.argument;
		break;
		}
	}
	}

	node.params = params;
	if (!hasDefaults) node.defaults = [];

	parseFunctionBody(node, true);
	return finishNode(node, "ArrowFunctionExpression");
}

// Parse function parameters.

function parseFunctionParams(node) {
	var defaults = [], hasDefaults = false;

	expect(_parenL);
	for (;;) {
	if (eat(_parenR)) {
		break;
	} else if (options.ecmaVersion >= 6 && eat(_ellipsis)) {
		node.rest = toAssignable(parseExprAtom(), false, true);
		checkSpreadAssign(node.rest);
		expect(_parenR);
		break;
	} else {
		node.params.push(options.ecmaVersion >= 6 ? toAssignable(parseExprAtom(), false, true) : parseIdent());
		if (options.ecmaVersion >= 6 && tokType === _eq) {
		next();
		hasDefaults = true;
		defaults.push(parseExpression(true));
		}
		if (!eat(_comma)) {
		expect(_parenR);
		break;
		}
	}
	}

	if (hasDefaults) node.defaults = defaults;
}

// Parse function body and check parameters.

function parseFunctionBody(node, allowExpression) {
	var isExpression = allowExpression && tokType !== _braceL;

	if (isExpression) {
	node.body = parseExpression(true);
	node.expression = true;
	} else {
	// Start a new scope with regard to labels and the `inFunction`
	// flag (restore them to their old value afterwards).
	var oldInFunc = inFunction, oldInGen = inGenerator, oldLabels = labels;
	inFunction = true; inGenerator = node.generator; labels = [];
	node.body = parseBlock(true);
	node.expression = false;
	inFunction = oldInFunc; inGenerator = oldInGen; labels = oldLabels;
	}

	// If this is a strict mode function, verify that argument names
	// are not repeated, and it does not try to bind the words `eval`
	// or `arguments`.
	if (strict || !isExpression && node.body.body.length && isUseStrict(node.body.body[0])) {
	var nameHash = {};
	if (node.id)
		checkFunctionParam(node.id, nameHash);
	for (var i = 0; i < node.params.length; i++)
		checkFunctionParam(node.params[i], nameHash);
	if (node.rest)
		checkFunctionParam(node.rest, nameHash);
	}
}

// Parse a class declaration or literal (depending on the
// `isStatement` parameter).

function parseClass(node, isStatement) {
	next();
	node.id = tokType === _name ? parseIdent() : isStatement ? unexpected() : null;
	node.superClass = eat(_extends) ? parseExpression() : null;
	var classBody = startNode(), methodHash = {}, staticMethodHash = {};
	classBody.body = [];
	expect(_braceL);
	while (!eat(_braceR)) {
	var method = startNode();
	if (tokType === _name && tokVal === "static") {
		next();
		method['static'] = true;
	} else {
		method['static'] = false;
	}
	var isGenerator = eat(_star);
	parsePropertyName(method);
	if (tokType === _name && !method.computed && method.key.type === "Identifier" &&
		(method.key.name === "get" || method.key.name === "set")) {
		if (isGenerator) unexpected();
		method.kind = method.key.name;
		parsePropertyName(method);
	} else {
		method.kind = "";
	}
	method.value = parseMethod(isGenerator);
	checkPropClash(method, method['static'] ? staticMethodHash : methodHash);
	classBody.body.push(finishNode(method, "MethodDefinition"));
	eat(_semi);
	}
	node.body = finishNode(classBody, "ClassBody");
	return finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
}

// Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).

function parseExprList(close, allowTrailingComma, allowEmpty) {
	var elts = [], first = true;
	while (!eat(close)) {
	if (!first) {
		expect(_comma);
		if (allowTrailingComma && options.allowTrailingCommas && eat(close)) break;
	} else first = false;

	if (allowEmpty && tokType === _comma) elts.push(null);
	else elts.push(parseExpression(true));
	}
	return elts;
}

// Parse the next token as an identifier. If `liberal` is true (used
// when parsing properties), it will also convert keywords into
// identifiers.

function parseIdent(liberal) {
	var node = startNode();
	if (liberal && options.forbidReserved == "everywhere") liberal = false;
	if (tokType === _name) {
	if (!liberal &&
		(options.forbidReserved &&
		(options.ecmaVersion === 3 ? isReservedWord3 : isReservedWord5)(tokVal) ||
		strict && isStrictReservedWord(tokVal)) &&
		input.slice(tokStart, tokEnd).indexOf("\\") == -1)
		raise(tokStart, "The keyword '" + tokVal + "' is reserved");
	node.name = tokVal;
	} else if (liberal && tokType.keyword) {
	node.name = tokType.keyword;
	} else {
	unexpected();
	}
	tokRegexpAllowed = false;
	next();
	return finishNode(node, "Identifier");
}

// Parses module export declaration.

function parseExport(node) {
	next();
	// export var|const|let|function|class ...;
	if (tokType === _var || tokType === _const || tokType === _let || tokType === _function || tokType === _class) {
	node.declaration = parseStatement();
	node['default'] = false;
	node.specifiers = null;
	node.source = null;
	} else
	// export default ...;
	if (eat(_default)) {
	node.declaration = parseExpression(true);
	node['default'] = true;
	node.specifiers = null;
	node.source = null;
	semicolon();
	} else {
	// export * from '...'
	// export { x, y as z } [from '...']
	var isBatch = tokType === _star;
	node.declaration = null;
	node['default'] = false;
	node.specifiers = parseExportSpecifiers();
	if (tokType === _name && tokVal === "from") {
		next();
		node.source = tokType === _string ? parseExprAtom() : unexpected();
	} else {
		if (isBatch) unexpected();
		node.source = null;
	}
	}
	return finishNode(node, "ExportDeclaration");
}

// Parses a comma-separated list of module exports.

function parseExportSpecifiers() {
	var nodes = [], first = true;
	if (tokType === _star) {
	// export * from '...'
	var node = startNode();
	next();
	nodes.push(finishNode(node, "ExportBatchSpecifier"));
	} else {
	// export { x, y as z } [from '...']
	expect(_braceL);
	while (!eat(_braceR)) {
		if (!first) {
		expect(_comma);
		if (options.allowTrailingCommas && eat(_braceR)) break;
		} else first = false;

		var node = startNode();
		node.id = parseIdent();
		if (tokType === _name && tokVal === "as") {
		next();
		node.name = parseIdent(true);
		} else {
		node.name = null;
		}
		nodes.push(finishNode(node, "ExportSpecifier"));
	}
	}
	return nodes;
}

// Parses import declaration.

function parseImport(node) {
	next();
	// import '...';
	if (tokType === _string) {
	node.specifiers = [];
	node.source = parseExprAtom();
	node.kind = "";
	} else {
	node.specifiers = parseImportSpecifiers();
	if (tokType !== _name || tokVal !== "from") unexpected();
	next();
	node.source = tokType === _string ? parseExprAtom() : unexpected();
	// only for backward compatibility with Esprima's AST
	// (it doesn't support mixed default + named yet)
	node.kind = node.specifiers[0]['default'] ? "default" : "named";
	}
	return finishNode(node, "ImportDeclaration");
}

// Parses a comma-separated list of module imports.

function parseImportSpecifiers() {
	var nodes = [], first = true;
	if (tokType === _star) {
	var node = startNode();
	next();
	if (tokType !== _name || tokVal !== "as") unexpected();
	next();
	node.name = parseIdent();
	checkLVal(node.name, true);
	nodes.push(finishNode(node, "ImportBatchSpecifier"));
	return nodes;
	}
	if (tokType === _name) {
	// import defaultObj, { x, y as z } from '...'
	var node = startNode();
	node.id = parseIdent();
	checkLVal(node.id, true);
	node.name = null;
	node['default'] = true;
	nodes.push(finishNode(node, "ImportSpecifier"));
	if (!eat(_comma)) return nodes;
	}
	expect(_braceL);
	while (!eat(_braceR)) {
	if (!first) {
		expect(_comma);
		if (options.allowTrailingCommas && eat(_braceR)) break;
	} else first = false;

	var node = startNode();
	node.id = parseIdent(true);
	if (tokType === _name && tokVal === "as") {
		next();
		node.name = parseIdent();
	} else {
		node.name = null;
	}
	checkLVal(node.name || node.id, true);
	node['default'] = false;
	nodes.push(finishNode(node, "ImportSpecifier"));
	}
	return nodes;
}

// Parses yield expression inside generator.

function parseYield() {
	var node = startNode();
	next();
	if (eat(_semi) || canInsertSemicolon()) {
	node.delegate = false;
	node.argument = null;
	} else {
	node.delegate = eat(_star);
	node.argument = parseExpression(true);
	}
	return finishNode(node, "YieldExpression");
}

// Parses array and generator comprehensions.

function parseComprehension(node, isGenerator) {
	node.blocks = [];
	while (tokType === _for) {
	var block = startNode();
	next();
	expect(_parenL);
	block.left = toAssignable(parseExprAtom());
	checkLVal(block.left, true);
	if (tokType !== _name || tokVal !== "of") unexpected();
	next();
	// `of` property is here for compatibility with Esprima's AST
	// which also supports deprecated [for (... in ...) expr]
	block.of = true;
	block.right = parseExpression();
	expect(_parenR);
	node.blocks.push(finishNode(block, "ComprehensionBlock"));
	}
	node.filter = eat(_if) ? parseParenExpression() : null;
	node.body = parseExpression();
	expect(isGenerator ? _parenR : _bracketR);
	node.generator = isGenerator;
	return finishNode(node, "ComprehensionExpression");
}

});


// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

// This is CodeMirror (http://codemirror.net), a code editor
// implemented in JavaScript on top of the browser's DOM.
//
// You can find some technical background for some of the code below
// at http://marijnhaverbeke.nl/blog/#cm-internals .

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    module.exports = mod();
  else if (typeof define == "function" && define.amd) // AMD
    return define([], mod);
  else // Plain browser env
    this.CodeMirror = mod();
})(function() {
  "use strict";

  // BROWSER SNIFFING

  // Kludges for bugs and behavior differences that can't be feature
  // detected are enabled based on userAgent etc sniffing.

  var gecko = /gecko\/\d/i.test(navigator.userAgent);
  // ie_uptoN means Internet Explorer version N or lower
  var ie_upto10 = /MSIE \d/.test(navigator.userAgent);
  var ie_11up = /Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(navigator.userAgent);
  var ie = ie_upto10 || ie_11up;
  var ie_version = ie && (ie_upto10 ? document.documentMode || 6 : ie_11up[1]);
  var webkit = /WebKit\//.test(navigator.userAgent);
  var qtwebkit = webkit && /Qt\/\d+\.\d+/.test(navigator.userAgent);
  var chrome = /Chrome\//.test(navigator.userAgent);
  var presto = /Opera\//.test(navigator.userAgent);
  var safari = /Apple Computer/.test(navigator.vendor);
  var khtml = /KHTML\//.test(navigator.userAgent);
  var mac_geMountainLion = /Mac OS X 1\d\D([8-9]|\d\d)\D/.test(navigator.userAgent);
  var phantom = /PhantomJS/.test(navigator.userAgent);

  var ios = /AppleWebKit/.test(navigator.userAgent) && /Mobile\/\w+/.test(navigator.userAgent);
  // This is woefully incomplete. Suggestions for alternative methods welcome.
  var mobile = ios || /Android|webOS|BlackBerry|Opera Mini|Opera Mobi|IEMobile/i.test(navigator.userAgent);
  var mac = ios || /Mac/.test(navigator.platform);
  var windows = /win/i.test(navigator.platform);

  var presto_version = presto && navigator.userAgent.match(/Version\/(\d*\.\d*)/);
  if (presto_version) presto_version = Number(presto_version[1]);
  if (presto_version && presto_version >= 15) { presto = false; webkit = true; }
  // Some browsers use the wrong event properties to signal cmd/ctrl on OS X
  var flipCtrlCmd = mac && (qtwebkit || presto && (presto_version == null || presto_version < 12.11));
  var captureRightClick = gecko || (ie && ie_version >= 9);

  // Optimize some code when these features are not used.
  var sawReadOnlySpans = false, sawCollapsedSpans = false;

  // EDITOR CONSTRUCTOR

  // A CodeMirror instance represents an editor. This is the object
  // that user code is usually dealing with.

  function CodeMirror(place, options) {
    if (!(this instanceof CodeMirror)) return new CodeMirror(place, options);

    this.options = options = options || {};
    // Determine effective options based on given values and defaults.
    copyObj(defaults, options, false);
    setGuttersForLineNumbers(options);

    var doc = options.value;
    if (typeof doc == "string") doc = new Doc(doc, options.mode);
    this.doc = doc;

    var display = this.display = new Display(place, doc);
    display.wrapper.CodeMirror = this;
    updateGutters(this);
    themeChanged(this);
    if (options.lineWrapping)
      this.display.wrapper.className += " CodeMirror-wrap";
    if (options.autofocus && !mobile) focusInput(this);

    this.state = {
      keyMaps: [],  // stores maps added by addKeyMap
      overlays: [], // highlighting overlays, as added by addOverlay
      modeGen: 0,   // bumped when mode/overlay changes, used to invalidate highlighting info
      overwrite: false, focused: false,
      suppressEdits: false, // used to disable editing during key handlers when in readOnly mode
      pasteIncoming: false, cutIncoming: false, // help recognize paste/cut edits in readInput
      draggingText: false,
      highlight: new Delayed() // stores highlight worker timeout
    };

    // Override magic textarea content restore that IE sometimes does
    // on our hidden textarea on reload
    if (ie && ie_version < 11) setTimeout(bind(resetInput, this, true), 20);

    registerEventHandlers(this);
    ensureGlobalHandlers();

    var cm = this;
    runInOp(this, function() {
      cm.curOp.forceUpdate = true;
      attachDoc(cm, doc);

      if ((options.autofocus && !mobile) || activeElt() == display.input)
        setTimeout(bind(onFocus, cm), 20);
      else
        onBlur(cm);

      for (var opt in optionHandlers) if (optionHandlers.hasOwnProperty(opt))
        optionHandlers[opt](cm, options[opt], Init);
      for (var i = 0; i < initHooks.length; ++i) initHooks[i](cm);
    });
  }

  // DISPLAY CONSTRUCTOR

  // The display handles the DOM integration, both for input reading
  // and content drawing. It holds references to DOM nodes and
  // display-related state.

  function Display(place, doc) {
    var d = this;

    // The semihidden textarea that is focused when the editor is
    // focused, and receives input.
    var input = d.input = elt("textarea", null, null, "position: absolute; padding: 0; width: 1px; height: 1em; outline: none");
    // The textarea is kept positioned near the cursor to prevent the
    // fact that it'll be scrolled into view on input from scrolling
    // our fake cursor out of view. On webkit, when wrap=off, paste is
    // very slow. So make the area wide instead.
    if (webkit) input.style.width = "1000px";
    else input.setAttribute("wrap", "off");
    // If border: 0; -- iOS fails to open keyboard (issue #1287)
    if (ios) input.style.border = "1px solid black";
    input.setAttribute("autocorrect", "off"); input.setAttribute("autocapitalize", "off"); input.setAttribute("spellcheck", "false");

    // Wraps and hides input textarea
    d.inputDiv = elt("div", [input], null, "overflow: hidden; position: relative; width: 3px; height: 0px;");
    // The fake scrollbar elements.
    d.scrollbarH = elt("div", [elt("div", null, null, "height: 100%; min-height: 1px")], "CodeMirror-hscrollbar");
    d.scrollbarV = elt("div", [elt("div", null, null, "min-width: 1px")], "CodeMirror-vscrollbar");
    // Covers bottom-right square when both scrollbars are present.
    d.scrollbarFiller = elt("div", null, "CodeMirror-scrollbar-filler");
    // Covers bottom of gutter when coverGutterNextToScrollbar is on
    // and h scrollbar is present.
    d.gutterFiller = elt("div", null, "CodeMirror-gutter-filler");
    // Will contain the actual code, positioned to cover the viewport.
    d.lineDiv = elt("div", null, "CodeMirror-code");
    // Elements are added to these to represent selection and cursors.
    d.selectionDiv = elt("div", null, null, "position: relative; z-index: 1");
    d.cursorDiv = elt("div", null, "CodeMirror-cursors");
    // A visibility: hidden element used to find the size of things.
    d.measure = elt("div", null, "CodeMirror-measure");
    // When lines outside of the viewport are measured, they are drawn in this.
    d.lineMeasure = elt("div", null, "CodeMirror-measure");
    // Wraps everything that needs to exist inside the vertically-padded coordinate system
    d.lineSpace = elt("div", [d.measure, d.lineMeasure, d.selectionDiv, d.cursorDiv, d.lineDiv],
                      null, "position: relative; outline: none");
    // Moved around its parent to cover visible view.
    d.mover = elt("div", [elt("div", [d.lineSpace], "CodeMirror-lines")], null, "position: relative");
    // Set to the height of the document, allowing scrolling.
    d.sizer = elt("div", [d.mover], "CodeMirror-sizer");
    // Behavior of elts with overflow: auto and padding is
    // inconsistent across browsers. This is used to ensure the
    // scrollable area is big enough.
    d.heightForcer = elt("div", null, null, "position: absolute; height: " + scrollerCutOff + "px; width: 1px;");
    // Will contain the gutters, if any.
    d.gutters = elt("div", null, "CodeMirror-gutters");
    d.lineGutter = null;
    // Actual scrollable element.
    d.scroller = elt("div", [d.sizer, d.heightForcer, d.gutters], "CodeMirror-scroll");
    d.scroller.setAttribute("tabIndex", "-1");
    // The element in which the editor lives.
    d.wrapper = elt("div", [d.inputDiv, d.scrollbarH, d.scrollbarV,
                            d.scrollbarFiller, d.gutterFiller, d.scroller], "CodeMirror");

    // Work around IE7 z-index bug (not perfect, hence IE7 not really being supported)
    if (ie && ie_version < 8) { d.gutters.style.zIndex = -1; d.scroller.style.paddingRight = 0; }
    // Needed to hide big blue blinking cursor on Mobile Safari
    if (ios) input.style.width = "0px";
    if (!webkit) d.scroller.draggable = true;
    // Needed to handle Tab key in KHTML
    if (khtml) { d.inputDiv.style.height = "1px"; d.inputDiv.style.position = "absolute"; }
    // Need to set a minimum width to see the scrollbar on IE7 (but must not set it on IE8).
    if (ie && ie_version < 8) d.scrollbarH.style.minHeight = d.scrollbarV.style.minWidth = "18px";

    if (place.appendChild) place.appendChild(d.wrapper);
    else place(d.wrapper);

    // Current rendered range (may be bigger than the view window).
    d.viewFrom = d.viewTo = doc.first;
    // Information about the rendered lines.
    d.view = [];
    // Holds info about a single rendered line when it was rendered
    // for measurement, while not in view.
    d.externalMeasured = null;
    // Empty space (in pixels) above the view
    d.viewOffset = 0;
    d.lastSizeC = 0;
    d.updateLineNumbers = null;

    // Used to only resize the line number gutter when necessary (when
    // the amount of lines crosses a boundary that makes its width change)
    d.lineNumWidth = d.lineNumInnerWidth = d.lineNumChars = null;
    // See readInput and resetInput
    d.prevInput = "";
    // Set to true when a non-horizontal-scrolling line widget is
    // added. As an optimization, line widget aligning is skipped when
    // this is false.
    d.alignWidgets = false;
    // Flag that indicates whether we expect input to appear real soon
    // now (after some event like 'keypress' or 'input') and are
    // polling intensively.
    d.pollingFast = false;
    // Self-resetting timeout for the poller
    d.poll = new Delayed();

    d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;

    // Tracks when resetInput has punted to just putting a short
    // string into the textarea instead of the full selection.
    d.inaccurateSelection = false;

    // Tracks the maximum line length so that the horizontal scrollbar
    // can be kept static when scrolling.
    d.maxLine = null;
    d.maxLineLength = 0;
    d.maxLineChanged = false;

    // Used for measuring wheel scrolling granularity
    d.wheelDX = d.wheelDY = d.wheelStartX = d.wheelStartY = null;

    // True when shift is held down.
    d.shift = false;

    // Used to track whether anything happened since the context menu
    // was opened.
    d.selForContextMenu = null;
  }

  // STATE UPDATES

  // Used to get the editor into a consistent state again when options change.

  function loadMode(cm) {
    cm.doc.mode = CodeMirror.getMode(cm.options, cm.doc.modeOption);
    resetModeState(cm);
  }

  function resetModeState(cm) {
    cm.doc.iter(function(line) {
      if (line.stateAfter) line.stateAfter = null;
      if (line.styles) line.styles = null;
    });
    cm.doc.frontier = cm.doc.first;
    startWorker(cm, 100);
    cm.state.modeGen++;
    if (cm.curOp) regChange(cm);
  }

  function wrappingChanged(cm) {
    if (cm.options.lineWrapping) {
      addClass(cm.display.wrapper, "CodeMirror-wrap");
      cm.display.sizer.style.minWidth = "";
    } else {
      rmClass(cm.display.wrapper, "CodeMirror-wrap");
      findMaxLine(cm);
    }
    estimateLineHeights(cm);
    regChange(cm);
    clearCaches(cm);
    setTimeout(function(){updateScrollbars(cm);}, 100);
  }

  // Returns a function that estimates the height of a line, to use as
  // first approximation until the line becomes visible (and is thus
  // properly measurable).
  function estimateHeight(cm) {
    var th = textHeight(cm.display), wrapping = cm.options.lineWrapping;
    var perLine = wrapping && Math.max(5, cm.display.scroller.clientWidth / charWidth(cm.display) - 3);
    return function(line) {
      if (lineIsHidden(cm.doc, line)) return 0;

      var widgetsHeight = 0;
      if (line.widgets) for (var i = 0; i < line.widgets.length; i++) {
        if (line.widgets[i].height) widgetsHeight += line.widgets[i].height;
      }

      if (wrapping)
        return widgetsHeight + (Math.ceil(line.text.length / perLine) || 1) * th;
      else
        return widgetsHeight + th;
    };
  }

  function estimateLineHeights(cm) {
    var doc = cm.doc, est = estimateHeight(cm);
    doc.iter(function(line) {
      var estHeight = est(line);
      if (estHeight != line.height) updateLineHeight(line, estHeight);
    });
  }

  function keyMapChanged(cm) {
    var map = keyMap[cm.options.keyMap], style = map.style;
    cm.display.wrapper.className = cm.display.wrapper.className.replace(/\s*cm-keymap-\S+/g, "") +
      (style ? " cm-keymap-" + style : "");
  }

  function themeChanged(cm) {
    cm.display.wrapper.className = cm.display.wrapper.className.replace(/\s*cm-s-\S+/g, "") +
      cm.options.theme.replace(/(^|\s)\s*/g, " cm-s-");
    clearCaches(cm);
  }

  function guttersChanged(cm) {
    updateGutters(cm);
    regChange(cm);
    setTimeout(function(){alignHorizontally(cm);}, 20);
  }

  // Rebuild the gutter elements, ensure the margin to the left of the
  // code matches their width.
  function updateGutters(cm) {
    var gutters = cm.display.gutters, specs = cm.options.gutters;
    removeChildren(gutters);
    for (var i = 0; i < specs.length; ++i) {
      var gutterClass = specs[i];
      var gElt = gutters.appendChild(elt("div", null, "CodeMirror-gutter " + gutterClass));
      if (gutterClass == "CodeMirror-linenumbers") {
        cm.display.lineGutter = gElt;
        gElt.style.width = (cm.display.lineNumWidth || 1) + "px";
      }
    }
    gutters.style.display = i ? "" : "none";
    updateGutterSpace(cm);
  }

  function updateGutterSpace(cm) {
    var width = cm.display.gutters.offsetWidth;
    cm.display.sizer.style.marginLeft = width + "px";
    cm.display.scrollbarH.style.left = cm.options.fixedGutter ? width + "px" : 0;
  }

  // Compute the character length of a line, taking into account
  // collapsed ranges (see markText) that might hide parts, and join
  // other lines onto it.
  function lineLength(line) {
    if (line.height == 0) return 0;
    var len = line.text.length, merged, cur = line;
    while (merged = collapsedSpanAtStart(cur)) {
      var found = merged.find(0, true);
      cur = found.from.line;
      len += found.from.ch - found.to.ch;
    }
    cur = line;
    while (merged = collapsedSpanAtEnd(cur)) {
      var found = merged.find(0, true);
      len -= cur.text.length - found.from.ch;
      cur = found.to.line;
      len += cur.text.length - found.to.ch;
    }
    return len;
  }

  // Find the longest line in the document.
  function findMaxLine(cm) {
    var d = cm.display, doc = cm.doc;
    d.maxLine = getLine(doc, doc.first);
    d.maxLineLength = lineLength(d.maxLine);
    d.maxLineChanged = true;
    doc.iter(function(line) {
      var len = lineLength(line);
      if (len > d.maxLineLength) {
        d.maxLineLength = len;
        d.maxLine = line;
      }
    });
  }

  // Make sure the gutters options contains the element
  // "CodeMirror-linenumbers" when the lineNumbers option is true.
  function setGuttersForLineNumbers(options) {
    var found = indexOf(options.gutters, "CodeMirror-linenumbers");
    if (found == -1 && options.lineNumbers) {
      options.gutters = options.gutters.concat(["CodeMirror-linenumbers"]);
    } else if (found > -1 && !options.lineNumbers) {
      options.gutters = options.gutters.slice(0);
      options.gutters.splice(found, 1);
    }
  }

  // SCROLLBARS

  function hScrollbarTakesSpace(cm) {
    return cm.display.scroller.clientHeight - cm.display.wrapper.clientHeight < scrollerCutOff - 3;
  }

  // Prepare DOM reads needed to update the scrollbars. Done in one
  // shot to minimize update/measure roundtrips.
  function measureForScrollbars(cm) {
    var scroll = cm.display.scroller;
    return {
      clientHeight: scroll.clientHeight,
      barHeight: cm.display.scrollbarV.clientHeight,
      scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
      hScrollbarTakesSpace: hScrollbarTakesSpace(cm),
      barWidth: cm.display.scrollbarH.clientWidth,
      docHeight: Math.round(cm.doc.height + paddingVert(cm.display))
    };
  }

  // Re-synchronize the fake scrollbars with the actual size of the
  // content.
  function updateScrollbars(cm, measure) {
    if (!measure) measure = measureForScrollbars(cm);
    var d = cm.display, sWidth = scrollbarWidth(d.measure);
    var scrollHeight = measure.docHeight + scrollerCutOff;
    var needsH = measure.scrollWidth > measure.clientWidth;
    if (needsH && measure.scrollWidth <= measure.clientWidth + 1 &&
        sWidth > 0 && !measure.hScrollbarTakesSpace)
      needsH = false; // (Issue #2562)
    var needsV = scrollHeight > measure.clientHeight;

    if (needsV) {
      d.scrollbarV.style.display = "block";
      d.scrollbarV.style.bottom = needsH ? sWidth + "px" : "0";
      // A bug in IE8 can cause this value to be negative, so guard it.
      d.scrollbarV.firstChild.style.height =
        Math.max(0, scrollHeight - measure.clientHeight + (measure.barHeight || d.scrollbarV.clientHeight)) + "px";
    } else {
      d.scrollbarV.style.display = "";
      d.scrollbarV.firstChild.style.height = "0";
    }
    if (needsH) {
      d.scrollbarH.style.display = "block";
      d.scrollbarH.style.right = needsV ? sWidth + "px" : "0";
      d.scrollbarH.firstChild.style.width =
        (measure.scrollWidth - measure.clientWidth + (measure.barWidth || d.scrollbarH.clientWidth)) + "px";
    } else {
      d.scrollbarH.style.display = "";
      d.scrollbarH.firstChild.style.width = "0";
    }
    if (needsH && needsV) {
      d.scrollbarFiller.style.display = "block";
      d.scrollbarFiller.style.height = d.scrollbarFiller.style.width = sWidth + "px";
    } else d.scrollbarFiller.style.display = "";
    if (needsH && cm.options.coverGutterNextToScrollbar && cm.options.fixedGutter) {
      d.gutterFiller.style.display = "block";
      d.gutterFiller.style.height = sWidth + "px";
      d.gutterFiller.style.width = d.gutters.offsetWidth + "px";
    } else d.gutterFiller.style.display = "";

    if (!cm.state.checkedOverlayScrollbar && measure.clientHeight > 0) {
      if (sWidth === 0) {
        var w = mac && !mac_geMountainLion ? "12px" : "18px";
        d.scrollbarV.style.minWidth = d.scrollbarH.style.minHeight = w;
        var barMouseDown = function(e) {
          if (e_target(e) != d.scrollbarV && e_target(e) != d.scrollbarH)
            operation(cm, onMouseDown)(e);
        };
        on(d.scrollbarV, "mousedown", barMouseDown);
        on(d.scrollbarH, "mousedown", barMouseDown);
      }
      cm.state.checkedOverlayScrollbar = true;
    }
  }

  // Compute the lines that are visible in a given viewport (defaults
  // the the current scroll position). viewPort may contain top,
  // height, and ensure (see op.scrollToPos) properties.
  function visibleLines(display, doc, viewPort) {
    var top = viewPort && viewPort.top != null ? Math.max(0, viewPort.top) : display.scroller.scrollTop;
    top = Math.floor(top - paddingTop(display));
    var bottom = viewPort && viewPort.bottom != null ? viewPort.bottom : top + display.wrapper.clientHeight;

    var from = lineAtHeight(doc, top), to = lineAtHeight(doc, bottom);
    // Ensure is a {from: {line, ch}, to: {line, ch}} object, and
    // forces those lines into the viewport (if possible).
    if (viewPort && viewPort.ensure) {
      var ensureFrom = viewPort.ensure.from.line, ensureTo = viewPort.ensure.to.line;
      if (ensureFrom < from)
        return {from: ensureFrom,
                to: lineAtHeight(doc, heightAtLine(getLine(doc, ensureFrom)) + display.wrapper.clientHeight)};
      if (Math.min(ensureTo, doc.lastLine()) >= to)
        return {from: lineAtHeight(doc, heightAtLine(getLine(doc, ensureTo)) - display.wrapper.clientHeight),
                to: ensureTo};
    }
    return {from: from, to: Math.max(to, from + 1)};
  }

  // LINE NUMBERS

  // Re-align line numbers and gutter marks to compensate for
  // horizontal scrolling.
  function alignHorizontally(cm) {
    var display = cm.display, view = display.view;
    if (!display.alignWidgets && (!display.gutters.firstChild || !cm.options.fixedGutter)) return;
    var comp = compensateForHScroll(display) - display.scroller.scrollLeft + cm.doc.scrollLeft;
    var gutterW = display.gutters.offsetWidth, left = comp + "px";
    for (var i = 0; i < view.length; i++) if (!view[i].hidden) {
      if (cm.options.fixedGutter && view[i].gutter)
        view[i].gutter.style.left = left;
      var align = view[i].alignable;
      if (align) for (var j = 0; j < align.length; j++)
        align[j].style.left = left;
    }
    if (cm.options.fixedGutter)
      display.gutters.style.left = (comp + gutterW) + "px";
  }

  // Used to ensure that the line number gutter is still the right
  // size for the current document size. Returns true when an update
  // is needed.
  function maybeUpdateLineNumberWidth(cm) {
    if (!cm.options.lineNumbers) return false;
    var doc = cm.doc, last = lineNumberFor(cm.options, doc.first + doc.size - 1), display = cm.display;
    if (last.length != display.lineNumChars) {
      var test = display.measure.appendChild(elt("div", [elt("div", last)],
                                                 "CodeMirror-linenumber CodeMirror-gutter-elt"));
      var innerW = test.firstChild.offsetWidth, padding = test.offsetWidth - innerW;
      display.lineGutter.style.width = "";
      display.lineNumInnerWidth = Math.max(innerW, display.lineGutter.offsetWidth - padding);
      display.lineNumWidth = display.lineNumInnerWidth + padding;
      display.lineNumChars = display.lineNumInnerWidth ? last.length : -1;
      display.lineGutter.style.width = display.lineNumWidth + "px";
      updateGutterSpace(cm);
      return true;
    }
    return false;
  }

  function lineNumberFor(options, i) {
    return String(options.lineNumberFormatter(i + options.firstLineNumber));
  }

  // Computes display.scroller.scrollLeft + display.gutters.offsetWidth,
  // but using getBoundingClientRect to get a sub-pixel-accurate
  // result.
  function compensateForHScroll(display) {
    return display.scroller.getBoundingClientRect().left - display.sizer.getBoundingClientRect().left;
  }

  // DISPLAY DRAWING

  // Updates the display, selection, and scrollbars, using the
  // information in display.view to find out which nodes are no longer
  // up-to-date. Tries to bail out early when no changes are needed,
  // unless forced is true.
  // Returns true if an actual update happened, false otherwise.
  function updateDisplay(cm, viewPort, forced) {
    var oldFrom = cm.display.viewFrom, oldTo = cm.display.viewTo, updated;
    var visible = visibleLines(cm.display, cm.doc, viewPort);
    for (var first = true;; first = false) {
      var oldWidth = cm.display.scroller.clientWidth;
      if (!updateDisplayInner(cm, visible, forced)) break;
      updated = true;

      // If the max line changed since it was last measured, measure it,
      // and ensure the document's width matches it.
      if (cm.display.maxLineChanged && !cm.options.lineWrapping)
        adjustContentWidth(cm);

      var barMeasure = measureForScrollbars(cm);
      updateSelection(cm);
      setDocumentHeight(cm, barMeasure);
      updateScrollbars(cm, barMeasure);
      if (webkit && cm.options.lineWrapping)
        checkForWebkitWidthBug(cm, barMeasure); // (Issue #2420)
      if (webkit && barMeasure.scrollWidth > barMeasure.clientWidth &&
          barMeasure.scrollWidth < barMeasure.clientWidth + 1 &&
          !hScrollbarTakesSpace(cm))
        updateScrollbars(cm); // (Issue #2562)
      if (first && cm.options.lineWrapping && oldWidth != cm.display.scroller.clientWidth) {
        forced = true;
        continue;
      }
      forced = false;

      // Clip forced viewport to actual scrollable area.
      if (viewPort && viewPort.top != null)
        viewPort = {top: Math.min(barMeasure.docHeight - scrollerCutOff - barMeasure.clientHeight, viewPort.top)};
      // Updated line heights might result in the drawn area not
      // actually covering the viewport. Keep looping until it does.
      visible = visibleLines(cm.display, cm.doc, viewPort);
      if (visible.from >= cm.display.viewFrom && visible.to <= cm.display.viewTo)
        break;
    }

    cm.display.updateLineNumbers = null;
    if (updated) {
      signalLater(cm, "update", cm);
      if (cm.display.viewFrom != oldFrom || cm.display.viewTo != oldTo)
        signalLater(cm, "viewportChange", cm, cm.display.viewFrom, cm.display.viewTo);
    }
    return updated;
  }

  // Does the actual updating of the line display. Bails out
  // (returning false) when there is nothing to be done and forced is
  // false.
  function updateDisplayInner(cm, visible, forced) {
    var display = cm.display, doc = cm.doc;
    if (!display.wrapper.offsetWidth) {
      resetView(cm);
      return;
    }

    // Bail out if the visible area is already rendered and nothing changed.
    if (!forced && visible.from >= display.viewFrom && visible.to <= display.viewTo &&
        (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo) &&
        countDirtyView(cm) == 0)
      return;

    if (maybeUpdateLineNumberWidth(cm))
      resetView(cm);
    var dims = getDimensions(cm);

    // Compute a suitable new viewport (from & to)
    var end = doc.first + doc.size;
    var from = Math.max(visible.from - cm.options.viewportMargin, doc.first);
    var to = Math.min(end, visible.to + cm.options.viewportMargin);
    if (display.viewFrom < from && from - display.viewFrom < 20) from = Math.max(doc.first, display.viewFrom);
    if (display.viewTo > to && display.viewTo - to < 20) to = Math.min(end, display.viewTo);
    if (sawCollapsedSpans) {
      from = visualLineNo(cm.doc, from);
      to = visualLineEndNo(cm.doc, to);
    }

    var different = from != display.viewFrom || to != display.viewTo ||
      display.lastSizeC != display.wrapper.clientHeight;
    adjustView(cm, from, to);

    display.viewOffset = heightAtLine(getLine(cm.doc, display.viewFrom));
    // Position the mover div to align with the current scroll position
    cm.display.mover.style.top = display.viewOffset + "px";

    var toUpdate = countDirtyView(cm);
    if (!different && toUpdate == 0 && !forced) return;

    // For big changes, we hide the enclosing element during the
    // update, since that speeds up the operations on most browsers.
    var focused = activeElt();
    if (toUpdate > 4) display.lineDiv.style.display = "none";
    patchDisplay(cm, display.updateLineNumbers, dims);
    if (toUpdate > 4) display.lineDiv.style.display = "";
    // There might have been a widget with a focused element that got
    // hidden or updated, if so re-focus it.
    if (focused && activeElt() != focused && focused.offsetHeight) focused.focus();

    // Prevent selection and cursors from interfering with the scroll
    // width.
    removeChildren(display.cursorDiv);
    removeChildren(display.selectionDiv);

    if (different) {
      display.lastSizeC = display.wrapper.clientHeight;
      startWorker(cm, 400);
    }

    updateHeightsInViewport(cm);

    return true;
  }

  function adjustContentWidth(cm) {
    var display = cm.display;
    var width = measureChar(cm, display.maxLine, display.maxLine.text.length).left;
    display.maxLineChanged = false;
    var minWidth = Math.max(0, width + 3);
    var maxScrollLeft = Math.max(0, display.sizer.offsetLeft + minWidth + scrollerCutOff - display.scroller.clientWidth);
    display.sizer.style.minWidth = minWidth + "px";
    if (maxScrollLeft < cm.doc.scrollLeft)
      setScrollLeft(cm, Math.min(display.scroller.scrollLeft, maxScrollLeft), true);
  }

  function setDocumentHeight(cm, measure) {
    cm.display.sizer.style.minHeight = cm.display.heightForcer.style.top = measure.docHeight + "px";
    cm.display.gutters.style.height = Math.max(measure.docHeight, measure.clientHeight - scrollerCutOff) + "px";
  }

  function checkForWebkitWidthBug(cm, measure) {
    // Work around Webkit bug where it sometimes reserves space for a
    // non-existing phantom scrollbar in the scroller (Issue #2420)
    if (cm.display.sizer.offsetWidth + cm.display.gutters.offsetWidth < cm.display.scroller.clientWidth - 1) {
      cm.display.sizer.style.minHeight = cm.display.heightForcer.style.top = "0px";
      cm.display.gutters.style.height = measure.docHeight + "px";
    }
  }

  // Read the actual heights of the rendered lines, and update their
  // stored heights to match.
  function updateHeightsInViewport(cm) {
    var display = cm.display;
    var prevBottom = display.lineDiv.offsetTop;
    for (var i = 0; i < display.view.length; i++) {
      var cur = display.view[i], height;
      if (cur.hidden) continue;
      if (ie && ie_version < 8) {
        var bot = cur.node.offsetTop + cur.node.offsetHeight;
        height = bot - prevBottom;
        prevBottom = bot;
      } else {
        var box = cur.node.getBoundingClientRect();
        height = box.bottom - box.top;
      }
      var diff = cur.line.height - height;
      if (height < 2) height = textHeight(display);
      if (diff > .001 || diff < -.001) {
        updateLineHeight(cur.line, height);
        updateWidgetHeight(cur.line);
        if (cur.rest) for (var j = 0; j < cur.rest.length; j++)
          updateWidgetHeight(cur.rest[j]);
      }
    }
  }

  // Read and store the height of line widgets associated with the
  // given line.
  function updateWidgetHeight(line) {
    if (line.widgets) for (var i = 0; i < line.widgets.length; ++i)
      line.widgets[i].height = line.widgets[i].node.offsetHeight;
  }

  // Do a bulk-read of the DOM positions and sizes needed to draw the
  // view, so that we don't interleave reading and writing to the DOM.
  function getDimensions(cm) {
    var d = cm.display, left = {}, width = {};
    for (var n = d.gutters.firstChild, i = 0; n; n = n.nextSibling, ++i) {
      left[cm.options.gutters[i]] = n.offsetLeft;
      width[cm.options.gutters[i]] = n.offsetWidth;
    }
    return {fixedPos: compensateForHScroll(d),
            gutterTotalWidth: d.gutters.offsetWidth,
            gutterLeft: left,
            gutterWidth: width,
            wrapperWidth: d.wrapper.clientWidth};
  }

  // Sync the actual display DOM structure with display.view, removing
  // nodes for lines that are no longer in view, and creating the ones
  // that are not there yet, and updating the ones that are out of
  // date.
  function patchDisplay(cm, updateNumbersFrom, dims) {
    var display = cm.display, lineNumbers = cm.options.lineNumbers;
    var container = display.lineDiv, cur = container.firstChild;

    function rm(node) {
      var next = node.nextSibling;
      // Works around a throw-scroll bug in OS X Webkit
      if (webkit && mac && cm.display.currentWheelTarget == node)
        node.style.display = "none";
      else
        node.parentNode.removeChild(node);
      return next;
    }

    var view = display.view, lineN = display.viewFrom;
    // Loop over the elements in the view, syncing cur (the DOM nodes
    // in display.lineDiv) with the view as we go.
    for (var i = 0; i < view.length; i++) {
      var lineView = view[i];
      if (lineView.hidden) {
      } else if (!lineView.node) { // Not drawn yet
        var node = buildLineElement(cm, lineView, lineN, dims);
        container.insertBefore(node, cur);
      } else { // Already drawn
        while (cur != lineView.node) cur = rm(cur);
        var updateNumber = lineNumbers && updateNumbersFrom != null &&
          updateNumbersFrom <= lineN && lineView.lineNumber;
        if (lineView.changes) {
          if (indexOf(lineView.changes, "gutter") > -1) updateNumber = false;
          updateLineForChanges(cm, lineView, lineN, dims);
        }
        if (updateNumber) {
          removeChildren(lineView.lineNumber);
          lineView.lineNumber.appendChild(document.createTextNode(lineNumberFor(cm.options, lineN)));
        }
        cur = lineView.node.nextSibling;
      }
      lineN += lineView.size;
    }
    while (cur) cur = rm(cur);
  }

  // When an aspect of a line changes, a string is added to
  // lineView.changes. This updates the relevant part of the line's
  // DOM structure.
  function updateLineForChanges(cm, lineView, lineN, dims) {
    for (var j = 0; j < lineView.changes.length; j++) {
      var type = lineView.changes[j];
      if (type == "text") updateLineText(cm, lineView);
      else if (type == "gutter") updateLineGutter(cm, lineView, lineN, dims);
      else if (type == "class") updateLineClasses(lineView);
      else if (type == "widget") updateLineWidgets(lineView, dims);
    }
    lineView.changes = null;
  }

  // Lines with gutter elements, widgets or a background class need to
  // be wrapped, and have the extra elements added to the wrapper div
  function ensureLineWrapped(lineView) {
    if (lineView.node == lineView.text) {
      lineView.node = elt("div", null, null, "position: relative");
      if (lineView.text.parentNode)
        lineView.text.parentNode.replaceChild(lineView.node, lineView.text);
      lineView.node.appendChild(lineView.text);
      if (ie && ie_version < 8) lineView.node.style.zIndex = 2;
    }
    return lineView.node;
  }

  function updateLineBackground(lineView) {
    var cls = lineView.bgClass ? lineView.bgClass + " " + (lineView.line.bgClass || "") : lineView.line.bgClass;
    if (cls) cls += " CodeMirror-linebackground";
    if (lineView.background) {
      if (cls) lineView.background.className = cls;
      else { lineView.background.parentNode.removeChild(lineView.background); lineView.background = null; }
    } else if (cls) {
      var wrap = ensureLineWrapped(lineView);
      lineView.background = wrap.insertBefore(elt("div", null, cls), wrap.firstChild);
    }
  }

  // Wrapper around buildLineContent which will reuse the structure
  // in display.externalMeasured when possible.
  function getLineContent(cm, lineView) {
    var ext = cm.display.externalMeasured;
    if (ext && ext.line == lineView.line) {
      cm.display.externalMeasured = null;
      lineView.measure = ext.measure;
      return ext.built;
    }
    return buildLineContent(cm, lineView);
  }

  // Redraw the line's text. Interacts with the background and text
  // classes because the mode may output tokens that influence these
  // classes.
  function updateLineText(cm, lineView) {
    var cls = lineView.text.className;
    var built = getLineContent(cm, lineView);
    if (lineView.text == lineView.node) lineView.node = built.pre;
    lineView.text.parentNode.replaceChild(built.pre, lineView.text);
    lineView.text = built.pre;
    if (built.bgClass != lineView.bgClass || built.textClass != lineView.textClass) {
      lineView.bgClass = built.bgClass;
      lineView.textClass = built.textClass;
      updateLineClasses(lineView);
    } else if (cls) {
      lineView.text.className = cls;
    }
  }

  function updateLineClasses(lineView) {
    updateLineBackground(lineView);
    if (lineView.line.wrapClass)
      ensureLineWrapped(lineView).className = lineView.line.wrapClass;
    else if (lineView.node != lineView.text)
      lineView.node.className = "";
    var textClass = lineView.textClass ? lineView.textClass + " " + (lineView.line.textClass || "") : lineView.line.textClass;
    lineView.text.className = textClass || "";
  }

  function updateLineGutter(cm, lineView, lineN, dims) {
    if (lineView.gutter) {
      lineView.node.removeChild(lineView.gutter);
      lineView.gutter = null;
    }
    var markers = lineView.line.gutterMarkers;
    if (cm.options.lineNumbers || markers) {
      var wrap = ensureLineWrapped(lineView);
      var gutterWrap = lineView.gutter =
        wrap.insertBefore(elt("div", null, "CodeMirror-gutter-wrapper", "position: absolute; left: " +
                              (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) + "px"),
                          lineView.text);
      if (cm.options.lineNumbers && (!markers || !markers["CodeMirror-linenumbers"]))
        lineView.lineNumber = gutterWrap.appendChild(
          elt("div", lineNumberFor(cm.options, lineN),
              "CodeMirror-linenumber CodeMirror-gutter-elt",
              "left: " + dims.gutterLeft["CodeMirror-linenumbers"] + "px; width: "
              + cm.display.lineNumInnerWidth + "px"));
      if (markers) for (var k = 0; k < cm.options.gutters.length; ++k) {
        var id = cm.options.gutters[k], found = markers.hasOwnProperty(id) && markers[id];
        if (found)
          gutterWrap.appendChild(elt("div", [found], "CodeMirror-gutter-elt", "left: " +
                                     dims.gutterLeft[id] + "px; width: " + dims.gutterWidth[id] + "px"));
      }
    }
  }

  function updateLineWidgets(lineView, dims) {
    if (lineView.alignable) lineView.alignable = null;
    for (var node = lineView.node.firstChild, next; node; node = next) {
      var next = node.nextSibling;
      if (node.className == "CodeMirror-linewidget")
        lineView.node.removeChild(node);
    }
    insertLineWidgets(lineView, dims);
  }

  // Build a line's DOM representation from scratch
  function buildLineElement(cm, lineView, lineN, dims) {
    var built = getLineContent(cm, lineView);
    lineView.text = lineView.node = built.pre;
    if (built.bgClass) lineView.bgClass = built.bgClass;
    if (built.textClass) lineView.textClass = built.textClass;

    updateLineClasses(lineView);
    updateLineGutter(cm, lineView, lineN, dims);
    insertLineWidgets(lineView, dims);
    return lineView.node;
  }

  // A lineView may contain multiple logical lines (when merged by
  // collapsed spans). The widgets for all of them need to be drawn.
  function insertLineWidgets(lineView, dims) {
    insertLineWidgetsFor(lineView.line, lineView, dims, true);
    if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
      insertLineWidgetsFor(lineView.rest[i], lineView, dims, false);
  }

  function insertLineWidgetsFor(line, lineView, dims, allowAbove) {
    if (!line.widgets) return;
    var wrap = ensureLineWrapped(lineView);
    for (var i = 0, ws = line.widgets; i < ws.length; ++i) {
      var widget = ws[i], node = elt("div", [widget.node], "CodeMirror-linewidget");
      if (!widget.handleMouseEvents) node.ignoreEvents = true;
      positionLineWidget(widget, node, lineView, dims);
      if (allowAbove && widget.above)
        wrap.insertBefore(node, lineView.gutter || lineView.text);
      else
        wrap.appendChild(node);
      signalLater(widget, "redraw");
    }
  }

  function positionLineWidget(widget, node, lineView, dims) {
    if (widget.noHScroll) {
      (lineView.alignable || (lineView.alignable = [])).push(node);
      var width = dims.wrapperWidth;
      node.style.left = dims.fixedPos + "px";
      if (!widget.coverGutter) {
        width -= dims.gutterTotalWidth;
        node.style.paddingLeft = dims.gutterTotalWidth + "px";
      }
      node.style.width = width + "px";
    }
    if (widget.coverGutter) {
      node.style.zIndex = 5;
      node.style.position = "relative";
      if (!widget.noHScroll) node.style.marginLeft = -dims.gutterTotalWidth + "px";
    }
  }

  // POSITION OBJECT

  // A Pos instance represents a position within the text.
  var Pos = CodeMirror.Pos = function(line, ch) {
    if (!(this instanceof Pos)) return new Pos(line, ch);
    this.line = line; this.ch = ch;
  };

  // Compare two positions, return 0 if they are the same, a negative
  // number when a is less, and a positive number otherwise.
  var cmp = CodeMirror.cmpPos = function(a, b) { return a.line - b.line || a.ch - b.ch; };

  function copyPos(x) {return Pos(x.line, x.ch);}
  function maxPos(a, b) { return cmp(a, b) < 0 ? b : a; }
  function minPos(a, b) { return cmp(a, b) < 0 ? a : b; }

  // SELECTION / CURSOR

  // Selection objects are immutable. A new one is created every time
  // the selection changes. A selection is one or more non-overlapping
  // (and non-touching) ranges, sorted, and an integer that indicates
  // which one is the primary selection (the one that's scrolled into
  // view, that getCursor returns, etc).
  function Selection(ranges, primIndex) {
    this.ranges = ranges;
    this.primIndex = primIndex;
  }

  Selection.prototype = {
    primary: function() { return this.ranges[this.primIndex]; },
    equals: function(other) {
      if (other == this) return true;
      if (other.primIndex != this.primIndex || other.ranges.length != this.ranges.length) return false;
      for (var i = 0; i < this.ranges.length; i++) {
        var here = this.ranges[i], there = other.ranges[i];
        if (cmp(here.anchor, there.anchor) != 0 || cmp(here.head, there.head) != 0) return false;
      }
      return true;
    },
    deepCopy: function() {
      for (var out = [], i = 0; i < this.ranges.length; i++)
        out[i] = new Range(copyPos(this.ranges[i].anchor), copyPos(this.ranges[i].head));
      return new Selection(out, this.primIndex);
    },
    somethingSelected: function() {
      for (var i = 0; i < this.ranges.length; i++)
        if (!this.ranges[i].empty()) return true;
      return false;
    },
    contains: function(pos, end) {
      if (!end) end = pos;
      for (var i = 0; i < this.ranges.length; i++) {
        var range = this.ranges[i];
        if (cmp(end, range.from()) >= 0 && cmp(pos, range.to()) <= 0)
          return i;
      }
      return -1;
    }
  };

  function Range(anchor, head) {
    this.anchor = anchor; this.head = head;
  }

  Range.prototype = {
    from: function() { return minPos(this.anchor, this.head); },
    to: function() { return maxPos(this.anchor, this.head); },
    empty: function() {
      return this.head.line == this.anchor.line && this.head.ch == this.anchor.ch;
    }
  };

  // Take an unsorted, potentially overlapping set of ranges, and
  // build a selection out of it. 'Consumes' ranges array (modifying
  // it).
  function normalizeSelection(ranges, primIndex) {
    var prim = ranges[primIndex];
    ranges.sort(function(a, b) { return cmp(a.from(), b.from()); });
    primIndex = indexOf(ranges, prim);
    for (var i = 1; i < ranges.length; i++) {
      var cur = ranges[i], prev = ranges[i - 1];
      if (cmp(prev.to(), cur.from()) >= 0) {
        var from = minPos(prev.from(), cur.from()), to = maxPos(prev.to(), cur.to());
        var inv = prev.empty() ? cur.from() == cur.head : prev.from() == prev.head;
        if (i <= primIndex) --primIndex;
        ranges.splice(--i, 2, new Range(inv ? to : from, inv ? from : to));
      }
    }
    return new Selection(ranges, primIndex);
  }

  function simpleSelection(anchor, head) {
    return new Selection([new Range(anchor, head || anchor)], 0);
  }

  // Most of the external API clips given positions to make sure they
  // actually exist within the document.
  function clipLine(doc, n) {return Math.max(doc.first, Math.min(n, doc.first + doc.size - 1));}
  function clipPos(doc, pos) {
    if (pos.line < doc.first) return Pos(doc.first, 0);
    var last = doc.first + doc.size - 1;
    if (pos.line > last) return Pos(last, getLine(doc, last).text.length);
    return clipToLen(pos, getLine(doc, pos.line).text.length);
  }
  function clipToLen(pos, linelen) {
    var ch = pos.ch;
    if (ch == null || ch > linelen) return Pos(pos.line, linelen);
    else if (ch < 0) return Pos(pos.line, 0);
    else return pos;
  }
  function isLine(doc, l) {return l >= doc.first && l < doc.first + doc.size;}
  function clipPosArray(doc, array) {
    for (var out = [], i = 0; i < array.length; i++) out[i] = clipPos(doc, array[i]);
    return out;
  }

  // SELECTION UPDATES

  // The 'scroll' parameter given to many of these indicated whether
  // the new cursor position should be scrolled into view after
  // modifying the selection.

  // If shift is held or the extend flag is set, extends a range to
  // include a given position (and optionally a second position).
  // Otherwise, simply returns the range between the given positions.
  // Used for cursor motion and such.
  function extendRange(doc, range, head, other) {
    if (doc.cm && doc.cm.display.shift || doc.extend) {
      var anchor = range.anchor;
      if (other) {
        var posBefore = cmp(head, anchor) < 0;
        if (posBefore != (cmp(other, anchor) < 0)) {
          anchor = head;
          head = other;
        } else if (posBefore != (cmp(head, other) < 0)) {
          head = other;
        }
      }
      return new Range(anchor, head);
    } else {
      return new Range(other || head, head);
    }
  }

  // Extend the primary selection range, discard the rest.
  function extendSelection(doc, head, other, options) {
    setSelection(doc, new Selection([extendRange(doc, doc.sel.primary(), head, other)], 0), options);
  }

  // Extend all selections (pos is an array of selections with length
  // equal the number of selections)
  function extendSelections(doc, heads, options) {
    for (var out = [], i = 0; i < doc.sel.ranges.length; i++)
      out[i] = extendRange(doc, doc.sel.ranges[i], heads[i], null);
    var newSel = normalizeSelection(out, doc.sel.primIndex);
    setSelection(doc, newSel, options);
  }

  // Updates a single range in the selection.
  function replaceOneSelection(doc, i, range, options) {
    var ranges = doc.sel.ranges.slice(0);
    ranges[i] = range;
    setSelection(doc, normalizeSelection(ranges, doc.sel.primIndex), options);
  }

  // Reset the selection to a single range.
  function setSimpleSelection(doc, anchor, head, options) {
    setSelection(doc, simpleSelection(anchor, head), options);
  }

  // Give beforeSelectionChange handlers a change to influence a
  // selection update.
  function filterSelectionChange(doc, sel) {
    var obj = {
      ranges: sel.ranges,
      update: function(ranges) {
        this.ranges = [];
        for (var i = 0; i < ranges.length; i++)
          this.ranges[i] = new Range(clipPos(doc, ranges[i].anchor),
                                     clipPos(doc, ranges[i].head));
      }
    };
    signal(doc, "beforeSelectionChange", doc, obj);
    if (doc.cm) signal(doc.cm, "beforeSelectionChange", doc.cm, obj);
    if (obj.ranges != sel.ranges) return normalizeSelection(obj.ranges, obj.ranges.length - 1);
    else return sel;
  }

  function setSelectionReplaceHistory(doc, sel, options) {
    var done = doc.history.done, last = lst(done);
    if (last && last.ranges) {
      done[done.length - 1] = sel;
      setSelectionNoUndo(doc, sel, options);
    } else {
      setSelection(doc, sel, options);
    }
  }

  // Set a new selection.
  function setSelection(doc, sel, options) {
    setSelectionNoUndo(doc, sel, options);
    addSelectionToHistory(doc, doc.sel, doc.cm ? doc.cm.curOp.id : NaN, options);
  }

  function setSelectionNoUndo(doc, sel, options) {
    if (hasHandler(doc, "beforeSelectionChange") || doc.cm && hasHandler(doc.cm, "beforeSelectionChange"))
      sel = filterSelectionChange(doc, sel);

    var bias = options && options.bias ||
      (cmp(sel.primary().head, doc.sel.primary().head) < 0 ? -1 : 1);
    setSelectionInner(doc, skipAtomicInSelection(doc, sel, bias, true));

    if (!(options && options.scroll === false) && doc.cm)
      ensureCursorVisible(doc.cm);
  }

  function setSelectionInner(doc, sel) {
    if (sel.equals(doc.sel)) return;

    doc.sel = sel;

    if (doc.cm) {
      doc.cm.curOp.updateInput = doc.cm.curOp.selectionChanged = true;
      signalCursorActivity(doc.cm);
    }
    signalLater(doc, "cursorActivity", doc);
  }

  // Verify that the selection does not partially select any atomic
  // marked ranges.
  function reCheckSelection(doc) {
    setSelectionInner(doc, skipAtomicInSelection(doc, doc.sel, null, false), sel_dontScroll);
  }

  // Return a selection that does not partially select any atomic
  // ranges.
  function skipAtomicInSelection(doc, sel, bias, mayClear) {
    var out;
    for (var i = 0; i < sel.ranges.length; i++) {
      var range = sel.ranges[i];
      var newAnchor = skipAtomic(doc, range.anchor, bias, mayClear);
      var newHead = skipAtomic(doc, range.head, bias, mayClear);
      if (out || newAnchor != range.anchor || newHead != range.head) {
        if (!out) out = sel.ranges.slice(0, i);
        out[i] = new Range(newAnchor, newHead);
      }
    }
    return out ? normalizeSelection(out, sel.primIndex) : sel;
  }

  // Ensure a given position is not inside an atomic range.
  function skipAtomic(doc, pos, bias, mayClear) {
    var flipped = false, curPos = pos;
    var dir = bias || 1;
    doc.cantEdit = false;
    search: for (;;) {
      var line = getLine(doc, curPos.line);
      if (line.markedSpans) {
        for (var i = 0; i < line.markedSpans.length; ++i) {
          var sp = line.markedSpans[i], m = sp.marker;
          if ((sp.from == null || (m.inclusiveLeft ? sp.from <= curPos.ch : sp.from < curPos.ch)) &&
              (sp.to == null || (m.inclusiveRight ? sp.to >= curPos.ch : sp.to > curPos.ch))) {
            if (mayClear) {
              signal(m, "beforeCursorEnter");
              if (m.explicitlyCleared) {
                if (!line.markedSpans) break;
                else {--i; continue;}
              }
            }
            if (!m.atomic) continue;
            var newPos = m.find(dir < 0 ? -1 : 1);
            if (cmp(newPos, curPos) == 0) {
              newPos.ch += dir;
              if (newPos.ch < 0) {
                if (newPos.line > doc.first) newPos = clipPos(doc, Pos(newPos.line - 1));
                else newPos = null;
              } else if (newPos.ch > line.text.length) {
                if (newPos.line < doc.first + doc.size - 1) newPos = Pos(newPos.line + 1, 0);
                else newPos = null;
              }
              if (!newPos) {
                if (flipped) {
                  // Driven in a corner -- no valid cursor position found at all
                  // -- try again *with* clearing, if we didn't already
                  if (!mayClear) return skipAtomic(doc, pos, bias, true);
                  // Otherwise, turn off editing until further notice, and return the start of the doc
                  doc.cantEdit = true;
                  return Pos(doc.first, 0);
                }
                flipped = true; newPos = pos; dir = -dir;
              }
            }
            curPos = newPos;
            continue search;
          }
        }
      }
      return curPos;
    }
  }

  // SELECTION DRAWING

  // Redraw the selection and/or cursor
  function updateSelection(cm) {
    var display = cm.display, doc = cm.doc;
    var curFragment = document.createDocumentFragment();
    var selFragment = document.createDocumentFragment();

    for (var i = 0; i < doc.sel.ranges.length; i++) {
      var range = doc.sel.ranges[i];
      var collapsed = range.empty();
      if (collapsed || cm.options.showCursorWhenSelecting)
        drawSelectionCursor(cm, range, curFragment);
      if (!collapsed)
        drawSelectionRange(cm, range, selFragment);
    }

    // Move the hidden textarea near the cursor to prevent scrolling artifacts
    if (cm.options.moveInputWithCursor) {
      var headPos = cursorCoords(cm, doc.sel.primary().head, "div");
      var wrapOff = display.wrapper.getBoundingClientRect(), lineOff = display.lineDiv.getBoundingClientRect();
      var top = Math.max(0, Math.min(display.wrapper.clientHeight - 10,
                                     headPos.top + lineOff.top - wrapOff.top));
      var left = Math.max(0, Math.min(display.wrapper.clientWidth - 10,
                                      headPos.left + lineOff.left - wrapOff.left));
      display.inputDiv.style.top = top + "px";
      display.inputDiv.style.left = left + "px";
    }

    removeChildrenAndAdd(display.cursorDiv, curFragment);
    removeChildrenAndAdd(display.selectionDiv, selFragment);
  }

  // Draws a cursor for the given range
  function drawSelectionCursor(cm, range, output) {
    var pos = cursorCoords(cm, range.head, "div", null, null, !cm.options.singleCursorHeightPerLine);

    var cursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor"));
    cursor.style.left = pos.left + "px";
    cursor.style.top = pos.top + "px";
    cursor.style.height = Math.max(0, pos.bottom - pos.top) * cm.options.cursorHeight + "px";

    if (pos.other) {
      // Secondary cursor, shown when on a 'jump' in bi-directional text
      var otherCursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor CodeMirror-secondarycursor"));
      otherCursor.style.display = "";
      otherCursor.style.left = pos.other.left + "px";
      otherCursor.style.top = pos.other.top + "px";
      otherCursor.style.height = (pos.other.bottom - pos.other.top) * .85 + "px";
    }
  }

  // Draws the given range as a highlighted selection
  function drawSelectionRange(cm, range, output) {
    var display = cm.display, doc = cm.doc;
    var fragment = document.createDocumentFragment();
    var padding = paddingH(cm.display), leftSide = padding.left, rightSide = display.lineSpace.offsetWidth - padding.right;

    function add(left, top, width, bottom) {
      if (top < 0) top = 0;
      top = Math.round(top);
      bottom = Math.round(bottom);
      fragment.appendChild(elt("div", null, "CodeMirror-selected", "position: absolute; left: " + left +
                               "px; top: " + top + "px; width: " + (width == null ? rightSide - left : width) +
                               "px; height: " + (bottom - top) + "px"));
    }

    function drawForLine(line, fromArg, toArg) {
      var lineObj = getLine(doc, line);
      var lineLen = lineObj.text.length;
      var start, end;
      function coords(ch, bias) {
        return charCoords(cm, Pos(line, ch), "div", lineObj, bias);
      }

      iterateBidiSections(getOrder(lineObj), fromArg || 0, toArg == null ? lineLen : toArg, function(from, to, dir) {
        var leftPos = coords(from, "left"), rightPos, left, right;
        if (from == to) {
          rightPos = leftPos;
          left = right = leftPos.left;
        } else {
          rightPos = coords(to - 1, "right");
          if (dir == "rtl") { var tmp = leftPos; leftPos = rightPos; rightPos = tmp; }
          left = leftPos.left;
          right = rightPos.right;
        }
        if (fromArg == null && from == 0) left = leftSide;
        if (rightPos.top - leftPos.top > 3) { // Different lines, draw top part
          add(left, leftPos.top, null, leftPos.bottom);
          left = leftSide;
          if (leftPos.bottom < rightPos.top) add(left, leftPos.bottom, null, rightPos.top);
        }
        if (toArg == null && to == lineLen) right = rightSide;
        if (!start || leftPos.top < start.top || leftPos.top == start.top && leftPos.left < start.left)
          start = leftPos;
        if (!end || rightPos.bottom > end.bottom || rightPos.bottom == end.bottom && rightPos.right > end.right)
          end = rightPos;
        if (left < leftSide + 1) left = leftSide;
        add(left, rightPos.top, right - left, rightPos.bottom);
      });
      return {start: start, end: end};
    }

    var sFrom = range.from(), sTo = range.to();
    if (sFrom.line == sTo.line) {
      drawForLine(sFrom.line, sFrom.ch, sTo.ch);
    } else {
      var fromLine = getLine(doc, sFrom.line), toLine = getLine(doc, sTo.line);
      var singleVLine = visualLine(fromLine) == visualLine(toLine);
      var leftEnd = drawForLine(sFrom.line, sFrom.ch, singleVLine ? fromLine.text.length + 1 : null).end;
      var rightStart = drawForLine(sTo.line, singleVLine ? 0 : null, sTo.ch).start;
      if (singleVLine) {
        if (leftEnd.top < rightStart.top - 2) {
          add(leftEnd.right, leftEnd.top, null, leftEnd.bottom);
          add(leftSide, rightStart.top, rightStart.left, rightStart.bottom);
        } else {
          add(leftEnd.right, leftEnd.top, rightStart.left - leftEnd.right, leftEnd.bottom);
        }
      }
      if (leftEnd.bottom < rightStart.top)
        add(leftSide, leftEnd.bottom, null, rightStart.top);
    }

    output.appendChild(fragment);
  }

  // Cursor-blinking
  function restartBlink(cm) {
    if (!cm.state.focused) return;
    var display = cm.display;
    clearInterval(display.blinker);
    var on = true;
    display.cursorDiv.style.visibility = "";
    if (cm.options.cursorBlinkRate > 0)
      display.blinker = setInterval(function() {
        display.cursorDiv.style.visibility = (on = !on) ? "" : "hidden";
      }, cm.options.cursorBlinkRate);
    else if (cm.options.cursorBlinkRate < 0)
      display.cursorDiv.style.visibility = "hidden";
  }

  // HIGHLIGHT WORKER

  function startWorker(cm, time) {
    if (cm.doc.mode.startState && cm.doc.frontier < cm.display.viewTo)
      cm.state.highlight.set(time, bind(highlightWorker, cm));
  }

  function highlightWorker(cm) {
    var doc = cm.doc;
    if (doc.frontier < doc.first) doc.frontier = doc.first;
    if (doc.frontier >= cm.display.viewTo) return;
    var end = +new Date + cm.options.workTime;
    var state = copyState(doc.mode, getStateBefore(cm, doc.frontier));

    runInOp(cm, function() {
    doc.iter(doc.frontier, Math.min(doc.first + doc.size, cm.display.viewTo + 500), function(line) {
      if (doc.frontier >= cm.display.viewFrom) { // Visible
        var oldStyles = line.styles;
        var highlighted = highlightLine(cm, line, state, true);
        line.styles = highlighted.styles;
        var oldCls = line.styleClasses, newCls = highlighted.classes;
        if (newCls) line.styleClasses = newCls;
        else if (oldCls) line.styleClasses = null;
        var ischange = !oldStyles || oldStyles.length != line.styles.length ||
          oldCls != newCls && (!oldCls || !newCls || oldCls.bgClass != newCls.bgClass || oldCls.textClass != newCls.textClass);
        for (var i = 0; !ischange && i < oldStyles.length; ++i) ischange = oldStyles[i] != line.styles[i];
        if (ischange) regLineChange(cm, doc.frontier, "text");
        line.stateAfter = copyState(doc.mode, state);
      } else {
        processLine(cm, line.text, state);
        line.stateAfter = doc.frontier % 5 == 0 ? copyState(doc.mode, state) : null;
      }
      ++doc.frontier;
      if (+new Date > end) {
        startWorker(cm, cm.options.workDelay);
        return true;
      }
    });
    });
  }

  // Finds the line to start with when starting a parse. Tries to
  // find a line with a stateAfter, so that it can start with a
  // valid state. If that fails, it returns the line with the
  // smallest indentation, which tends to need the least context to
  // parse correctly.
  function findStartLine(cm, n, precise) {
    var minindent, minline, doc = cm.doc;
    var lim = precise ? -1 : n - (cm.doc.mode.innerMode ? 1000 : 100);
    for (var search = n; search > lim; --search) {
      if (search <= doc.first) return doc.first;
      var line = getLine(doc, search - 1);
      if (line.stateAfter && (!precise || search <= doc.frontier)) return search;
      var indented = countColumn(line.text, null, cm.options.tabSize);
      if (minline == null || minindent > indented) {
        minline = search - 1;
        minindent = indented;
      }
    }
    return minline;
  }

  function getStateBefore(cm, n, precise) {
    var doc = cm.doc, display = cm.display;
    if (!doc.mode.startState) return true;
    var pos = findStartLine(cm, n, precise), state = pos > doc.first && getLine(doc, pos-1).stateAfter;
    if (!state) state = startState(doc.mode);
    else state = copyState(doc.mode, state);
    doc.iter(pos, n, function(line) {
      processLine(cm, line.text, state);
      var save = pos == n - 1 || pos % 5 == 0 || pos >= display.viewFrom && pos < display.viewTo;
      line.stateAfter = save ? copyState(doc.mode, state) : null;
      ++pos;
    });
    if (precise) doc.frontier = pos;
    return state;
  }

  // POSITION MEASUREMENT

  function paddingTop(display) {return display.lineSpace.offsetTop;}
  function paddingVert(display) {return display.mover.offsetHeight - display.lineSpace.offsetHeight;}
  function paddingH(display) {
    if (display.cachedPaddingH) return display.cachedPaddingH;
    var e = removeChildrenAndAdd(display.measure, elt("pre", "x"));
    var style = window.getComputedStyle ? window.getComputedStyle(e) : e.currentStyle;
    var data = {left: parseInt(style.paddingLeft), right: parseInt(style.paddingRight)};
    if (!isNaN(data.left) && !isNaN(data.right)) display.cachedPaddingH = data;
    return data;
  }

  // Ensure the lineView.wrapping.heights array is populated. This is
  // an array of bottom offsets for the lines that make up a drawn
  // line. When lineWrapping is on, there might be more than one
  // height.
  function ensureLineHeights(cm, lineView, rect) {
    var wrapping = cm.options.lineWrapping;
    var curWidth = wrapping && cm.display.scroller.clientWidth;
    if (!lineView.measure.heights || wrapping && lineView.measure.width != curWidth) {
      var heights = lineView.measure.heights = [];
      if (wrapping) {
        lineView.measure.width = curWidth;
        var rects = lineView.text.firstChild.getClientRects();
        for (var i = 0; i < rects.length - 1; i++) {
          var cur = rects[i], next = rects[i + 1];
          if (Math.abs(cur.bottom - next.bottom) > 2)
            heights.push((cur.bottom + next.top) / 2 - rect.top);
        }
      }
      heights.push(rect.bottom - rect.top);
    }
  }

  // Find a line map (mapping character offsets to text nodes) and a
  // measurement cache for the given line number. (A line view might
  // contain multiple lines when collapsed ranges are present.)
  function mapFromLineView(lineView, line, lineN) {
    if (lineView.line == line)
      return {map: lineView.measure.map, cache: lineView.measure.cache};
    for (var i = 0; i < lineView.rest.length; i++)
      if (lineView.rest[i] == line)
        return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i]};
    for (var i = 0; i < lineView.rest.length; i++)
      if (lineNo(lineView.rest[i]) > lineN)
        return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i], before: true};
  }

  // Render a line into the hidden node display.externalMeasured. Used
  // when measurement is needed for a line that's not in the viewport.
  function updateExternalMeasurement(cm, line) {
    line = visualLine(line);
    var lineN = lineNo(line);
    var view = cm.display.externalMeasured = new LineView(cm.doc, line, lineN);
    view.lineN = lineN;
    var built = view.built = buildLineContent(cm, view);
    view.text = built.pre;
    removeChildrenAndAdd(cm.display.lineMeasure, built.pre);
    return view;
  }

  // Get a {top, bottom, left, right} box (in line-local coordinates)
  // for a given character.
  function measureChar(cm, line, ch, bias) {
    return measureCharPrepared(cm, prepareMeasureForLine(cm, line), ch, bias);
  }

  // Find a line view that corresponds to the given line number.
  function findViewForLine(cm, lineN) {
    if (lineN >= cm.display.viewFrom && lineN < cm.display.viewTo)
      return cm.display.view[findViewIndex(cm, lineN)];
    var ext = cm.display.externalMeasured;
    if (ext && lineN >= ext.lineN && lineN < ext.lineN + ext.size)
      return ext;
  }

  // Measurement can be split in two steps, the set-up work that
  // applies to the whole line, and the measurement of the actual
  // character. Functions like coordsChar, that need to do a lot of
  // measurements in a row, can thus ensure that the set-up work is
  // only done once.
  function prepareMeasureForLine(cm, line) {
    var lineN = lineNo(line);
    var view = findViewForLine(cm, lineN);
    if (view && !view.text)
      view = null;
    else if (view && view.changes)
      updateLineForChanges(cm, view, lineN, getDimensions(cm));
    if (!view)
      view = updateExternalMeasurement(cm, line);

    var info = mapFromLineView(view, line, lineN);
    return {
      line: line, view: view, rect: null,
      map: info.map, cache: info.cache, before: info.before,
      hasHeights: false
    };
  }

  // Given a prepared measurement object, measures the position of an
  // actual character (or fetches it from the cache).
  function measureCharPrepared(cm, prepared, ch, bias, varHeight) {
    if (prepared.before) ch = -1;
    var key = ch + (bias || ""), found;
    if (prepared.cache.hasOwnProperty(key)) {
      found = prepared.cache[key];
    } else {
      if (!prepared.rect)
        prepared.rect = prepared.view.text.getBoundingClientRect();
      if (!prepared.hasHeights) {
        ensureLineHeights(cm, prepared.view, prepared.rect);
        prepared.hasHeights = true;
      }
      found = measureCharInner(cm, prepared, ch, bias);
      if (!found.bogus) prepared.cache[key] = found;
    }
    return {left: found.left, right: found.right,
            top: varHeight ? found.rtop : found.top,
            bottom: varHeight ? found.rbottom : found.bottom};
  }

  var nullRect = {left: 0, right: 0, top: 0, bottom: 0};

  function measureCharInner(cm, prepared, ch, bias) {
    var map = prepared.map;

    var node, start, end, collapse;
    // First, search the line map for the text node corresponding to,
    // or closest to, the target character.
    for (var i = 0; i < map.length; i += 3) {
      var mStart = map[i], mEnd = map[i + 1];
      if (ch < mStart) {
        start = 0; end = 1;
        collapse = "left";
      } else if (ch < mEnd) {
        start = ch - mStart;
        end = start + 1;
      } else if (i == map.length - 3 || ch == mEnd && map[i + 3] > ch) {
        end = mEnd - mStart;
        start = end - 1;
        if (ch >= mEnd) collapse = "right";
      }
      if (start != null) {
        node = map[i + 2];
        if (mStart == mEnd && bias == (node.insertLeft ? "left" : "right"))
          collapse = bias;
        if (bias == "left" && start == 0)
          while (i && map[i - 2] == map[i - 3] && map[i - 1].insertLeft) {
            node = map[(i -= 3) + 2];
            collapse = "left";
          }
        if (bias == "right" && start == mEnd - mStart)
          while (i < map.length - 3 && map[i + 3] == map[i + 4] && !map[i + 5].insertLeft) {
            node = map[(i += 3) + 2];
            collapse = "right";
          }
        break;
      }
    }

    var rect;
    if (node.nodeType == 3) { // If it is a text node, use a range to retrieve the coordinates.
      while (start && isExtendingChar(prepared.line.text.charAt(mStart + start))) --start;
      while (mStart + end < mEnd && isExtendingChar(prepared.line.text.charAt(mStart + end))) ++end;
      if (ie && ie_version < 9 && start == 0 && end == mEnd - mStart) {
        rect = node.parentNode.getBoundingClientRect();
      } else if (ie && cm.options.lineWrapping) {
        var rects = range(node, start, end).getClientRects();
        if (rects.length)
          rect = rects[bias == "right" ? rects.length - 1 : 0];
        else
          rect = nullRect;
      } else {
        rect = range(node, start, end).getBoundingClientRect() || nullRect;
      }
    } else { // If it is a widget, simply get the box for the whole widget.
      if (start > 0) collapse = bias = "right";
      var rects;
      if (cm.options.lineWrapping && (rects = node.getClientRects()).length > 1)
        rect = rects[bias == "right" ? rects.length - 1 : 0];
      else
        rect = node.getBoundingClientRect();
    }
    if (ie && ie_version < 9 && !start && (!rect || !rect.left && !rect.right)) {
      var rSpan = node.parentNode.getClientRects()[0];
      if (rSpan)
        rect = {left: rSpan.left, right: rSpan.left + charWidth(cm.display), top: rSpan.top, bottom: rSpan.bottom};
      else
        rect = nullRect;
    }

    var rtop = rect.top - prepared.rect.top, rbot = rect.bottom - prepared.rect.top;
    var mid = (rtop + rbot) / 2;
    var heights = prepared.view.measure.heights;
    for (var i = 0; i < heights.length - 1; i++)
      if (mid < heights[i]) break;
    var top = i ? heights[i - 1] : 0, bot = heights[i];
    var result = {left: (collapse == "right" ? rect.right : rect.left) - prepared.rect.left,
                  right: (collapse == "left" ? rect.left : rect.right) - prepared.rect.left,
                  top: top, bottom: bot};
    if (!rect.left && !rect.right) result.bogus = true;
    if (!cm.options.singleCursorHeightPerLine) { result.rtop = rtop; result.rbottom = rbot; }
    return result;
  }

  function clearLineMeasurementCacheFor(lineView) {
    if (lineView.measure) {
      lineView.measure.cache = {};
      lineView.measure.heights = null;
      if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
        lineView.measure.caches[i] = {};
    }
  }

  function clearLineMeasurementCache(cm) {
    cm.display.externalMeasure = null;
    removeChildren(cm.display.lineMeasure);
    for (var i = 0; i < cm.display.view.length; i++)
      clearLineMeasurementCacheFor(cm.display.view[i]);
  }

  function clearCaches(cm) {
    clearLineMeasurementCache(cm);
    cm.display.cachedCharWidth = cm.display.cachedTextHeight = cm.display.cachedPaddingH = null;
    if (!cm.options.lineWrapping) cm.display.maxLineChanged = true;
    cm.display.lineNumChars = null;
  }

  function pageScrollX() { return window.pageXOffset || (document.documentElement || document.body).scrollLeft; }
  function pageScrollY() { return window.pageYOffset || (document.documentElement || document.body).scrollTop; }

  // Converts a {top, bottom, left, right} box from line-local
  // coordinates into another coordinate system. Context may be one of
  // "line", "div" (display.lineDiv), "local"/null (editor), or "page".
  function intoCoordSystem(cm, lineObj, rect, context) {
    if (lineObj.widgets) for (var i = 0; i < lineObj.widgets.length; ++i) if (lineObj.widgets[i].above) {
      var size = widgetHeight(lineObj.widgets[i]);
      rect.top += size; rect.bottom += size;
    }
    if (context == "line") return rect;
    if (!context) context = "local";
    var yOff = heightAtLine(lineObj);
    if (context == "local") yOff += paddingTop(cm.display);
    else yOff -= cm.display.viewOffset;
    if (context == "page" || context == "window") {
      var lOff = cm.display.lineSpace.getBoundingClientRect();
      yOff += lOff.top + (context == "window" ? 0 : pageScrollY());
      var xOff = lOff.left + (context == "window" ? 0 : pageScrollX());
      rect.left += xOff; rect.right += xOff;
    }
    rect.top += yOff; rect.bottom += yOff;
    return rect;
  }

  // Coverts a box from "div" coords to another coordinate system.
  // Context may be "window", "page", "div", or "local"/null.
  function fromCoordSystem(cm, coords, context) {
    if (context == "div") return coords;
    var left = coords.left, top = coords.top;
    // First move into "page" coordinate system
    if (context == "page") {
      left -= pageScrollX();
      top -= pageScrollY();
    } else if (context == "local" || !context) {
      var localBox = cm.display.sizer.getBoundingClientRect();
      left += localBox.left;
      top += localBox.top;
    }

    var lineSpaceBox = cm.display.lineSpace.getBoundingClientRect();
    return {left: left - lineSpaceBox.left, top: top - lineSpaceBox.top};
  }

  function charCoords(cm, pos, context, lineObj, bias) {
    if (!lineObj) lineObj = getLine(cm.doc, pos.line);
    return intoCoordSystem(cm, lineObj, measureChar(cm, lineObj, pos.ch, bias), context);
  }

  // Returns a box for a given cursor position, which may have an
  // 'other' property containing the position of the secondary cursor
  // on a bidi boundary.
  function cursorCoords(cm, pos, context, lineObj, preparedMeasure, varHeight) {
    lineObj = lineObj || getLine(cm.doc, pos.line);
    if (!preparedMeasure) preparedMeasure = prepareMeasureForLine(cm, lineObj);
    function get(ch, right) {
      var m = measureCharPrepared(cm, preparedMeasure, ch, right ? "right" : "left", varHeight);
      if (right) m.left = m.right; else m.right = m.left;
      return intoCoordSystem(cm, lineObj, m, context);
    }
    function getBidi(ch, partPos) {
      var part = order[partPos], right = part.level % 2;
      if (ch == bidiLeft(part) && partPos && part.level < order[partPos - 1].level) {
        part = order[--partPos];
        ch = bidiRight(part) - (part.level % 2 ? 0 : 1);
        right = true;
      } else if (ch == bidiRight(part) && partPos < order.length - 1 && part.level < order[partPos + 1].level) {
        part = order[++partPos];
        ch = bidiLeft(part) - part.level % 2;
        right = false;
      }
      if (right && ch == part.to && ch > part.from) return get(ch - 1);
      return get(ch, right);
    }
    var order = getOrder(lineObj), ch = pos.ch;
    if (!order) return get(ch);
    var partPos = getBidiPartAt(order, ch);
    var val = getBidi(ch, partPos);
    if (bidiOther != null) val.other = getBidi(ch, bidiOther);
    return val;
  }

  // Used to cheaply estimate the coordinates for a position. Used for
  // intermediate scroll updates.
  function estimateCoords(cm, pos) {
    var left = 0, pos = clipPos(cm.doc, pos);
    if (!cm.options.lineWrapping) left = charWidth(cm.display) * pos.ch;
    var lineObj = getLine(cm.doc, pos.line);
    var top = heightAtLine(lineObj) + paddingTop(cm.display);
    return {left: left, right: left, top: top, bottom: top + lineObj.height};
  }

  // Positions returned by coordsChar contain some extra information.
  // xRel is the relative x position of the input coordinates compared
  // to the found position (so xRel > 0 means the coordinates are to
  // the right of the character position, for example). When outside
  // is true, that means the coordinates lie outside the line's
  // vertical range.
  function PosWithInfo(line, ch, outside, xRel) {
    var pos = Pos(line, ch);
    pos.xRel = xRel;
    if (outside) pos.outside = true;
    return pos;
  }

  // Compute the character position closest to the given coordinates.
  // Input must be lineSpace-local ("div" coordinate system).
  function coordsChar(cm, x, y) {
    var doc = cm.doc;
    y += cm.display.viewOffset;
    if (y < 0) return PosWithInfo(doc.first, 0, true, -1);
    var lineN = lineAtHeight(doc, y), last = doc.first + doc.size - 1;
    if (lineN > last)
      return PosWithInfo(doc.first + doc.size - 1, getLine(doc, last).text.length, true, 1);
    if (x < 0) x = 0;

    var lineObj = getLine(doc, lineN);
    for (;;) {
      var found = coordsCharInner(cm, lineObj, lineN, x, y);
      var merged = collapsedSpanAtEnd(lineObj);
      var mergedPos = merged && merged.find(0, true);
      if (merged && (found.ch > mergedPos.from.ch || found.ch == mergedPos.from.ch && found.xRel > 0))
        lineN = lineNo(lineObj = mergedPos.to.line);
      else
        return found;
    }
  }

  function coordsCharInner(cm, lineObj, lineNo, x, y) {
    var innerOff = y - heightAtLine(lineObj);
    var wrongLine = false, adjust = 2 * cm.display.wrapper.clientWidth;
    var preparedMeasure = prepareMeasureForLine(cm, lineObj);

    function getX(ch) {
      var sp = cursorCoords(cm, Pos(lineNo, ch), "line", lineObj, preparedMeasure);
      wrongLine = true;
      if (innerOff > sp.bottom) return sp.left - adjust;
      else if (innerOff < sp.top) return sp.left + adjust;
      else wrongLine = false;
      return sp.left;
    }

    var bidi = getOrder(lineObj), dist = lineObj.text.length;
    var from = lineLeft(lineObj), to = lineRight(lineObj);
    var fromX = getX(from), fromOutside = wrongLine, toX = getX(to), toOutside = wrongLine;

    if (x > toX) return PosWithInfo(lineNo, to, toOutside, 1);
    // Do a binary search between these bounds.
    for (;;) {
      if (bidi ? to == from || to == moveVisually(lineObj, from, 1) : to - from <= 1) {
        var ch = x < fromX || x - fromX <= toX - x ? from : to;
        var xDiff = x - (ch == from ? fromX : toX);
        while (isExtendingChar(lineObj.text.charAt(ch))) ++ch;
        var pos = PosWithInfo(lineNo, ch, ch == from ? fromOutside : toOutside,
                              xDiff < -1 ? -1 : xDiff > 1 ? 1 : 0);
        return pos;
      }
      var step = Math.ceil(dist / 2), middle = from + step;
      if (bidi) {
        middle = from;
        for (var i = 0; i < step; ++i) middle = moveVisually(lineObj, middle, 1);
      }
      var middleX = getX(middle);
      if (middleX > x) {to = middle; toX = middleX; if (toOutside = wrongLine) toX += 1000; dist = step;}
      else {from = middle; fromX = middleX; fromOutside = wrongLine; dist -= step;}
    }
  }

  var measureText;
  // Compute the default text height.
  function textHeight(display) {
    if (display.cachedTextHeight != null) return display.cachedTextHeight;
    if (measureText == null) {
      measureText = elt("pre");
      // Measure a bunch of lines, for browsers that compute
      // fractional heights.
      for (var i = 0; i < 49; ++i) {
        measureText.appendChild(document.createTextNode("x"));
        measureText.appendChild(elt("br"));
      }
      measureText.appendChild(document.createTextNode("x"));
    }
    removeChildrenAndAdd(display.measure, measureText);
    var height = measureText.offsetHeight / 50;
    if (height > 3) display.cachedTextHeight = height;
    removeChildren(display.measure);
    return height || 1;
  }

  // Compute the default character width.
  function charWidth(display) {
    if (display.cachedCharWidth != null) return display.cachedCharWidth;
    var anchor = elt("span", "xxxxxxxxxx");
    var pre = elt("pre", [anchor]);
    removeChildrenAndAdd(display.measure, pre);
    var rect = anchor.getBoundingClientRect(), width = (rect.right - rect.left) / 10;
    if (width > 2) display.cachedCharWidth = width;
    return width || 10;
  }

  // OPERATIONS

  // Operations are used to wrap a series of changes to the editor
  // state in such a way that each change won't have to update the
  // cursor and display (which would be awkward, slow, and
  // error-prone). Instead, display updates are batched and then all
  // combined and executed at once.

  var nextOpId = 0;
  // Start a new operation.
  function startOperation(cm) {
    cm.curOp = {
      viewChanged: false,      // Flag that indicates that lines might need to be redrawn
      startHeight: cm.doc.height, // Used to detect need to update scrollbar
      forceUpdate: false,      // Used to force a redraw
      updateInput: null,       // Whether to reset the input textarea
      typing: false,           // Whether this reset should be careful to leave existing text (for compositing)
      changeObjs: null,        // Accumulated changes, for firing change events
      cursorActivityHandlers: null, // Set of handlers to fire cursorActivity on
      selectionChanged: false, // Whether the selection needs to be redrawn
      updateMaxLine: false,    // Set when the widest line needs to be determined anew
      scrollLeft: null, scrollTop: null, // Intermediate scroll position, not pushed to DOM yet
      scrollToPos: null,       // Used to scroll to a specific position
      id: ++nextOpId           // Unique ID
    };
    if (!delayedCallbackDepth++) delayedCallbacks = [];
  }

  // Finish an operation, updating the display and signalling delayed events
  function endOperation(cm) {
    var op = cm.curOp, doc = cm.doc, display = cm.display;
    cm.curOp = null;

    if (op.updateMaxLine) findMaxLine(cm);

    // If it looks like an update might be needed, call updateDisplay
    if (op.viewChanged || op.forceUpdate || op.scrollTop != null ||
        op.scrollToPos && (op.scrollToPos.from.line < display.viewFrom ||
                           op.scrollToPos.to.line >= display.viewTo) ||
        display.maxLineChanged && cm.options.lineWrapping) {
      var updated = updateDisplay(cm, {top: op.scrollTop, ensure: op.scrollToPos}, op.forceUpdate);
      if (cm.display.scroller.offsetHeight) cm.doc.scrollTop = cm.display.scroller.scrollTop;
    }
    // If no update was run, but the selection changed, redraw that.
    if (!updated && op.selectionChanged) updateSelection(cm);
    if (!updated && op.startHeight != cm.doc.height) updateScrollbars(cm);

    // Abort mouse wheel delta measurement, when scrolling explicitly
    if (display.wheelStartX != null && (op.scrollTop != null || op.scrollLeft != null || op.scrollToPos))
      display.wheelStartX = display.wheelStartY = null;

    // Propagate the scroll position to the actual DOM scroller
    if (op.scrollTop != null && display.scroller.scrollTop != op.scrollTop) {
      var top = Math.max(0, Math.min(display.scroller.scrollHeight - display.scroller.clientHeight, op.scrollTop));
      display.scroller.scrollTop = display.scrollbarV.scrollTop = doc.scrollTop = top;
    }
    if (op.scrollLeft != null && display.scroller.scrollLeft != op.scrollLeft) {
      var left = Math.max(0, Math.min(display.scroller.scrollWidth - display.scroller.clientWidth, op.scrollLeft));
      display.scroller.scrollLeft = display.scrollbarH.scrollLeft = doc.scrollLeft = left;
      alignHorizontally(cm);
    }
    // If we need to scroll a specific position into view, do so.
    if (op.scrollToPos) {
      var coords = scrollPosIntoView(cm, clipPos(cm.doc, op.scrollToPos.from),
                                     clipPos(cm.doc, op.scrollToPos.to), op.scrollToPos.margin);
      if (op.scrollToPos.isCursor && cm.state.focused) maybeScrollWindow(cm, coords);
    }

    if (op.selectionChanged) restartBlink(cm);

    if (cm.state.focused && op.updateInput)
      resetInput(cm, op.typing);

    // Fire events for markers that are hidden/unidden by editing or
    // undoing
    var hidden = op.maybeHiddenMarkers, unhidden = op.maybeUnhiddenMarkers;
    if (hidden) for (var i = 0; i < hidden.length; ++i)
      if (!hidden[i].lines.length) signal(hidden[i], "hide");
    if (unhidden) for (var i = 0; i < unhidden.length; ++i)
      if (unhidden[i].lines.length) signal(unhidden[i], "unhide");

    var delayed;
    if (!--delayedCallbackDepth) {
      delayed = delayedCallbacks;
      delayedCallbacks = null;
    }
    // Fire change events, and delayed event handlers
    if (op.changeObjs)
      signal(cm, "changes", cm, op.changeObjs);
    if (delayed) for (var i = 0; i < delayed.length; ++i) delayed[i]();
    if (op.cursorActivityHandlers)
      for (var i = 0; i < op.cursorActivityHandlers.length; i++)
        op.cursorActivityHandlers[i](cm);
  }

  // Run the given function in an operation
  function runInOp(cm, f) {
    if (cm.curOp) return f();
    startOperation(cm);
    try { return f(); }
    finally { endOperation(cm); }
  }
  // Wraps a function in an operation. Returns the wrapped function.
  function operation(cm, f) {
    return function() {
      if (cm.curOp) return f.apply(cm, arguments);
      startOperation(cm);
      try { return f.apply(cm, arguments); }
      finally { endOperation(cm); }
    };
  }
  // Used to add methods to editor and doc instances, wrapping them in
  // operations.
  function methodOp(f) {
    return function() {
      if (this.curOp) return f.apply(this, arguments);
      startOperation(this);
      try { return f.apply(this, arguments); }
      finally { endOperation(this); }
    };
  }
  function docMethodOp(f) {
    return function() {
      var cm = this.cm;
      if (!cm || cm.curOp) return f.apply(this, arguments);
      startOperation(cm);
      try { return f.apply(this, arguments); }
      finally { endOperation(cm); }
    };
  }

  // VIEW TRACKING

  // These objects are used to represent the visible (currently drawn)
  // part of the document. A LineView may correspond to multiple
  // logical lines, if those are connected by collapsed ranges.
  function LineView(doc, line, lineN) {
    // The starting line
    this.line = line;
    // Continuing lines, if any
    this.rest = visualLineContinued(line);
    // Number of logical lines in this visual line
    this.size = this.rest ? lineNo(lst(this.rest)) - lineN + 1 : 1;
    this.node = this.text = null;
    this.hidden = lineIsHidden(doc, line);
  }

  // Create a range of LineView objects for the given lines.
  function buildViewArray(cm, from, to) {
    var array = [], nextPos;
    for (var pos = from; pos < to; pos = nextPos) {
      var view = new LineView(cm.doc, getLine(cm.doc, pos), pos);
      nextPos = pos + view.size;
      array.push(view);
    }
    return array;
  }

  // Updates the display.view data structure for a given change to the
  // document. From and to are in pre-change coordinates. Lendiff is
  // the amount of lines added or subtracted by the change. This is
  // used for changes that span multiple lines, or change the way
  // lines are divided into visual lines. regLineChange (below)
  // registers single-line changes.
  function regChange(cm, from, to, lendiff) {
    if (from == null) from = cm.doc.first;
    if (to == null) to = cm.doc.first + cm.doc.size;
    if (!lendiff) lendiff = 0;

    var display = cm.display;
    if (lendiff && to < display.viewTo &&
        (display.updateLineNumbers == null || display.updateLineNumbers > from))
      display.updateLineNumbers = from;

    cm.curOp.viewChanged = true;

    if (from >= display.viewTo) { // Change after
      if (sawCollapsedSpans && visualLineNo(cm.doc, from) < display.viewTo)
        resetView(cm);
    } else if (to <= display.viewFrom) { // Change before
      if (sawCollapsedSpans && visualLineEndNo(cm.doc, to + lendiff) > display.viewFrom) {
        resetView(cm);
      } else {
        display.viewFrom += lendiff;
        display.viewTo += lendiff;
      }
    } else if (from <= display.viewFrom && to >= display.viewTo) { // Full overlap
      resetView(cm);
    } else if (from <= display.viewFrom) { // Top overlap
      var cut = viewCuttingPoint(cm, to, to + lendiff, 1);
      if (cut) {
        display.view = display.view.slice(cut.index);
        display.viewFrom = cut.lineN;
        display.viewTo += lendiff;
      } else {
        resetView(cm);
      }
    } else if (to >= display.viewTo) { // Bottom overlap
      var cut = viewCuttingPoint(cm, from, from, -1);
      if (cut) {
        display.view = display.view.slice(0, cut.index);
        display.viewTo = cut.lineN;
      } else {
        resetView(cm);
      }
    } else { // Gap in the middle
      var cutTop = viewCuttingPoint(cm, from, from, -1);
      var cutBot = viewCuttingPoint(cm, to, to + lendiff, 1);
      if (cutTop && cutBot) {
        display.view = display.view.slice(0, cutTop.index)
          .concat(buildViewArray(cm, cutTop.lineN, cutBot.lineN))
          .concat(display.view.slice(cutBot.index));
        display.viewTo += lendiff;
      } else {
        resetView(cm);
      }
    }

    var ext = display.externalMeasured;
    if (ext) {
      if (to < ext.lineN)
        ext.lineN += lendiff;
      else if (from < ext.lineN + ext.size)
        display.externalMeasured = null;
    }
  }

  // Register a change to a single line. Type must be one of "text",
  // "gutter", "class", "widget"
  function regLineChange(cm, line, type) {
    cm.curOp.viewChanged = true;
    var display = cm.display, ext = cm.display.externalMeasured;
    if (ext && line >= ext.lineN && line < ext.lineN + ext.size)
      display.externalMeasured = null;

    if (line < display.viewFrom || line >= display.viewTo) return;
    var lineView = display.view[findViewIndex(cm, line)];
    if (lineView.node == null) return;
    var arr = lineView.changes || (lineView.changes = []);
    if (indexOf(arr, type) == -1) arr.push(type);
  }

  // Clear the view.
  function resetView(cm) {
    cm.display.viewFrom = cm.display.viewTo = cm.doc.first;
    cm.display.view = [];
    cm.display.viewOffset = 0;
  }

  // Find the view element corresponding to a given line. Return null
  // when the line isn't visible.
  function findViewIndex(cm, n) {
    if (n >= cm.display.viewTo) return null;
    n -= cm.display.viewFrom;
    if (n < 0) return null;
    var view = cm.display.view;
    for (var i = 0; i < view.length; i++) {
      n -= view[i].size;
      if (n < 0) return i;
    }
  }

  function viewCuttingPoint(cm, oldN, newN, dir) {
    var index = findViewIndex(cm, oldN), diff, view = cm.display.view;
    if (!sawCollapsedSpans || newN == cm.doc.first + cm.doc.size)
      return {index: index, lineN: newN};
    for (var i = 0, n = cm.display.viewFrom; i < index; i++)
      n += view[i].size;
    if (n != oldN) {
      if (dir > 0) {
        if (index == view.length - 1) return null;
        diff = (n + view[index].size) - oldN;
        index++;
      } else {
        diff = n - oldN;
      }
      oldN += diff; newN += diff;
    }
    while (visualLineNo(cm.doc, newN) != newN) {
      if (index == (dir < 0 ? 0 : view.length - 1)) return null;
      newN += dir * view[index - (dir < 0 ? 1 : 0)].size;
      index += dir;
    }
    return {index: index, lineN: newN};
  }

  // Force the view to cover a given range, adding empty view element
  // or clipping off existing ones as needed.
  function adjustView(cm, from, to) {
    var display = cm.display, view = display.view;
    if (view.length == 0 || from >= display.viewTo || to <= display.viewFrom) {
      display.view = buildViewArray(cm, from, to);
      display.viewFrom = from;
    } else {
      if (display.viewFrom > from)
        display.view = buildViewArray(cm, from, display.viewFrom).concat(display.view);
      else if (display.viewFrom < from)
        display.view = display.view.slice(findViewIndex(cm, from));
      display.viewFrom = from;
      if (display.viewTo < to)
        display.view = display.view.concat(buildViewArray(cm, display.viewTo, to));
      else if (display.viewTo > to)
        display.view = display.view.slice(0, findViewIndex(cm, to));
    }
    display.viewTo = to;
  }

  // Count the number of lines in the view whose DOM representation is
  // out of date (or nonexistent).
  function countDirtyView(cm) {
    var view = cm.display.view, dirty = 0;
    for (var i = 0; i < view.length; i++) {
      var lineView = view[i];
      if (!lineView.hidden && (!lineView.node || lineView.changes)) ++dirty;
    }
    return dirty;
  }

  // INPUT HANDLING

  // Poll for input changes, using the normal rate of polling. This
  // runs as long as the editor is focused.
  function slowPoll(cm) {
    if (cm.display.pollingFast) return;
    cm.display.poll.set(cm.options.pollInterval, function() {
      readInput(cm);
      if (cm.state.focused) slowPoll(cm);
    });
  }

  // When an event has just come in that is likely to add or change
  // something in the input textarea, we poll faster, to ensure that
  // the change appears on the screen quickly.
  function fastPoll(cm) {
    var missed = false;
    cm.display.pollingFast = true;
    function p() {
      var changed = readInput(cm);
      if (!changed && !missed) {missed = true; cm.display.poll.set(60, p);}
      else {cm.display.pollingFast = false; slowPoll(cm);}
    }
    cm.display.poll.set(20, p);
  }

  // Read input from the textarea, and update the document to match.
  // When something is selected, it is present in the textarea, and
  // selected (unless it is huge, in which case a placeholder is
  // used). When nothing is selected, the cursor sits after previously
  // seen text (can be empty), which is stored in prevInput (we must
  // not reset the textarea when typing, because that breaks IME).
  function readInput(cm) {
    var input = cm.display.input, prevInput = cm.display.prevInput, doc = cm.doc;
    // Since this is called a *lot*, try to bail out as cheaply as
    // possible when it is clear that nothing happened. hasSelection
    // will be the case when there is a lot of text in the textarea,
    // in which case reading its value would be expensive.
    if (!cm.state.focused || (hasSelection(input) && !prevInput) || isReadOnly(cm) || cm.options.disableInput)
      return false;
    // See paste handler for more on the fakedLastChar kludge
    if (cm.state.pasteIncoming && cm.state.fakedLastChar) {
      input.value = input.value.substring(0, input.value.length - 1);
      cm.state.fakedLastChar = false;
    }
    var text = input.value;
    // If nothing changed, bail.
    if (text == prevInput && !cm.somethingSelected()) return false;
    // Work around nonsensical selection resetting in IE9/10
    if (ie && ie_version >= 9 && cm.display.inputHasSelection === text) {
      resetInput(cm);
      return false;
    }

    var withOp = !cm.curOp;
    if (withOp) startOperation(cm);
    cm.display.shift = false;

    if (text.charCodeAt(0) == 0x200b && doc.sel == cm.display.selForContextMenu && !prevInput)
      prevInput = "\u200b";
    // Find the part of the input that is actually new
    var same = 0, l = Math.min(prevInput.length, text.length);
    while (same < l && prevInput.charCodeAt(same) == text.charCodeAt(same)) ++same;
    var inserted = text.slice(same), textLines = splitLines(inserted);

    // When pasing N lines into N selections, insert one line per selection
    var multiPaste = cm.state.pasteIncoming && textLines.length > 1 && doc.sel.ranges.length == textLines.length;

    // Normal behavior is to insert the new text into every selection
    for (var i = doc.sel.ranges.length - 1; i >= 0; i--) {
      var range = doc.sel.ranges[i];
      var from = range.from(), to = range.to();
      // Handle deletion
      if (same < prevInput.length)
        from = Pos(from.line, from.ch - (prevInput.length - same));
      // Handle overwrite
      else if (cm.state.overwrite && range.empty() && !cm.state.pasteIncoming)
        to = Pos(to.line, Math.min(getLine(doc, to.line).text.length, to.ch + lst(textLines).length));
      var updateInput = cm.curOp.updateInput;
      var changeEvent = {from: from, to: to, text: multiPaste ? [textLines[i]] : textLines,
                         origin: cm.state.pasteIncoming ? "paste" : cm.state.cutIncoming ? "cut" : "+input"};
      makeChange(cm.doc, changeEvent);
      signalLater(cm, "inputRead", cm, changeEvent);
      // When an 'electric' character is inserted, immediately trigger a reindent
      if (inserted && !cm.state.pasteIncoming && cm.options.electricChars &&
          cm.options.smartIndent && range.head.ch < 100 &&
          (!i || doc.sel.ranges[i - 1].head.line != range.head.line)) {
        var mode = cm.getModeAt(range.head);
        if (mode.electricChars) {
          for (var j = 0; j < mode.electricChars.length; j++)
            if (inserted.indexOf(mode.electricChars.charAt(j)) > -1) {
              indentLine(cm, range.head.line, "smart");
              break;
            }
        } else if (mode.electricInput) {
          var end = changeEnd(changeEvent);
          if (mode.electricInput.test(getLine(doc, end.line).text.slice(0, end.ch)))
            indentLine(cm, range.head.line, "smart");
        }
      }
    }
    ensureCursorVisible(cm);
    cm.curOp.updateInput = updateInput;
    cm.curOp.typing = true;

    // Don't leave long text in the textarea, since it makes further polling slow
    if (text.length > 1000 || text.indexOf("\n") > -1) input.value = cm.display.prevInput = "";
    else cm.display.prevInput = text;
    if (withOp) endOperation(cm);
    cm.state.pasteIncoming = cm.state.cutIncoming = false;
    return true;
  }

  // Reset the input to correspond to the selection (or to be empty,
  // when not typing and nothing is selected)
  function resetInput(cm, typing) {
    var minimal, selected, doc = cm.doc;
    if (cm.somethingSelected()) {
      cm.display.prevInput = "";
      var range = doc.sel.primary();
      minimal = hasCopyEvent &&
        (range.to().line - range.from().line > 100 || (selected = cm.getSelection()).length > 1000);
      var content = minimal ? "-" : selected || cm.getSelection();
      cm.display.input.value = content;
      if (cm.state.focused) selectInput(cm.display.input);
      if (ie && ie_version >= 9) cm.display.inputHasSelection = content;
    } else if (!typing) {
      cm.display.prevInput = cm.display.input.value = "";
      if (ie && ie_version >= 9) cm.display.inputHasSelection = null;
    }
    cm.display.inaccurateSelection = minimal;
  }

  function focusInput(cm) {
    if (cm.options.readOnly != "nocursor" && (!mobile || activeElt() != cm.display.input))
      cm.display.input.focus();
  }

  function ensureFocus(cm) {
    if (!cm.state.focused) { focusInput(cm); onFocus(cm); }
  }

  function isReadOnly(cm) {
    return cm.options.readOnly || cm.doc.cantEdit;
  }

  // EVENT HANDLERS

  // Attach the necessary event handlers when initializing the editor
  function registerEventHandlers(cm) {
    var d = cm.display;
    on(d.scroller, "mousedown", operation(cm, onMouseDown));
    // Older IE's will not fire a second mousedown for a double click
    if (ie && ie_version < 11)
      on(d.scroller, "dblclick", operation(cm, function(e) {
        if (signalDOMEvent(cm, e)) return;
        var pos = posFromMouse(cm, e);
        if (!pos || clickInGutter(cm, e) || eventInWidget(cm.display, e)) return;
        e_preventDefault(e);
        var word = findWordAt(cm, pos);
        extendSelection(cm.doc, word.anchor, word.head);
      }));
    else
      on(d.scroller, "dblclick", function(e) { signalDOMEvent(cm, e) || e_preventDefault(e); });
    // Prevent normal selection in the editor (we handle our own)
    on(d.lineSpace, "selectstart", function(e) {
      if (!eventInWidget(d, e)) e_preventDefault(e);
    });
    // Some browsers fire contextmenu *after* opening the menu, at
    // which point we can't mess with it anymore. Context menu is
    // handled in onMouseDown for these browsers.
    if (!captureRightClick) on(d.scroller, "contextmenu", function(e) {onContextMenu(cm, e);});

    // Sync scrolling between fake scrollbars and real scrollable
    // area, ensure viewport is updated when scrolling.
    on(d.scroller, "scroll", function() {
      if (d.scroller.clientHeight) {
        setScrollTop(cm, d.scroller.scrollTop);
        setScrollLeft(cm, d.scroller.scrollLeft, true);
        signal(cm, "scroll", cm);
      }
    });
    on(d.scrollbarV, "scroll", function() {
      if (d.scroller.clientHeight) setScrollTop(cm, d.scrollbarV.scrollTop);
    });
    on(d.scrollbarH, "scroll", function() {
      if (d.scroller.clientHeight) setScrollLeft(cm, d.scrollbarH.scrollLeft);
    });

    // Listen to wheel events in order to try and update the viewport on time.
    on(d.scroller, "mousewheel", function(e){onScrollWheel(cm, e);});
    on(d.scroller, "DOMMouseScroll", function(e){onScrollWheel(cm, e);});

    // Prevent clicks in the scrollbars from killing focus
    function reFocus() { if (cm.state.focused) setTimeout(bind(focusInput, cm), 0); }
    on(d.scrollbarH, "mousedown", reFocus);
    on(d.scrollbarV, "mousedown", reFocus);
    // Prevent wrapper from ever scrolling
    on(d.wrapper, "scroll", function() { d.wrapper.scrollTop = d.wrapper.scrollLeft = 0; });

    on(d.input, "keyup", operation(cm, onKeyUp));
    on(d.input, "input", function() {
      if (ie && ie_version >= 9 && cm.display.inputHasSelection) cm.display.inputHasSelection = null;
      fastPoll(cm);
    });
    on(d.input, "keydown", operation(cm, onKeyDown));
    on(d.input, "keypress", operation(cm, onKeyPress));
    on(d.input, "focus", bind(onFocus, cm));
    on(d.input, "blur", bind(onBlur, cm));

    function drag_(e) {
      if (!signalDOMEvent(cm, e)) e_stop(e);
    }
    if (cm.options.dragDrop) {
      on(d.scroller, "dragstart", function(e){onDragStart(cm, e);});
      on(d.scroller, "dragenter", drag_);
      on(d.scroller, "dragover", drag_);
      on(d.scroller, "drop", operation(cm, onDrop));
    }
    on(d.scroller, "paste", function(e) {
      if (eventInWidget(d, e)) return;
      cm.state.pasteIncoming = true;
      focusInput(cm);
      fastPoll(cm);
    });
    on(d.input, "paste", function() {
      // Workaround for webkit bug https://bugs.webkit.org/show_bug.cgi?id=90206
      // Add a char to the end of textarea before paste occur so that
      // selection doesn't span to the end of textarea.
      if (webkit && !cm.state.fakedLastChar && !(new Date - cm.state.lastMiddleDown < 200)) {
        var start = d.input.selectionStart, end = d.input.selectionEnd;
        d.input.value += "$";
        // The selection end needs to be set before the start, otherwise there
        // can be an intermediate non-empty selection between the two, which
        // can override the middle-click paste buffer on linux and cause the
        // wrong thing to get pasted.
        d.input.selectionEnd = end;
        d.input.selectionStart = start;
        cm.state.fakedLastChar = true;
      }
      cm.state.pasteIncoming = true;
      fastPoll(cm);
    });

    function prepareCopyCut(e) {
      if (cm.somethingSelected()) {
        if (d.inaccurateSelection) {
          d.prevInput = "";
          d.inaccurateSelection = false;
          d.input.value = cm.getSelection();
          selectInput(d.input);
        }
      } else {
        var text = "", ranges = [];
        for (var i = 0; i < cm.doc.sel.ranges.length; i++) {
          var line = cm.doc.sel.ranges[i].head.line;
          var lineRange = {anchor: Pos(line, 0), head: Pos(line + 1, 0)};
          ranges.push(lineRange);
          text += cm.getRange(lineRange.anchor, lineRange.head);
        }
        if (e.type == "cut") {
          cm.setSelections(ranges, null, sel_dontScroll);
        } else {
          d.prevInput = "";
          d.input.value = text;
          selectInput(d.input);
        }
      }
      if (e.type == "cut") cm.state.cutIncoming = true;
    }
    on(d.input, "cut", prepareCopyCut);
    on(d.input, "copy", prepareCopyCut);

    // Needed to handle Tab key in KHTML
    if (khtml) on(d.sizer, "mouseup", function() {
      if (activeElt() == d.input) d.input.blur();
      focusInput(cm);
    });
  }

  // Called when the window resizes
  function onResize(cm) {
    // Might be a text scaling operation, clear size caches.
    var d = cm.display;
    d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
    cm.setSize();
  }

  // MOUSE EVENTS

  // Return true when the given mouse event happened in a widget
  function eventInWidget(display, e) {
    for (var n = e_target(e); n != display.wrapper; n = n.parentNode) {
      if (!n || n.ignoreEvents || n.parentNode == display.sizer && n != display.mover) return true;
    }
  }

  // Given a mouse event, find the corresponding position. If liberal
  // is false, it checks whether a gutter or scrollbar was clicked,
  // and returns null if it was. forRect is used by rectangular
  // selections, and tries to estimate a character position even for
  // coordinates beyond the right of the text.
  function posFromMouse(cm, e, liberal, forRect) {
    var display = cm.display;
    if (!liberal) {
      var target = e_target(e);
      if (target == display.scrollbarH || target == display.scrollbarV ||
          target == display.scrollbarFiller || target == display.gutterFiller) return null;
    }
    var x, y, space = display.lineSpace.getBoundingClientRect();
    // Fails unpredictably on IE[67] when mouse is dragged around quickly.
    try { x = e.clientX - space.left; y = e.clientY - space.top; }
    catch (e) { return null; }
    var coords = coordsChar(cm, x, y), line;
    if (forRect && coords.xRel == 1 && (line = getLine(cm.doc, coords.line).text).length == coords.ch) {
      var colDiff = countColumn(line, line.length, cm.options.tabSize) - line.length;
      coords = Pos(coords.line, Math.max(0, Math.round((x - paddingH(cm.display).left) / charWidth(cm.display)) - colDiff));
    }
    return coords;
  }

  // A mouse down can be a single click, double click, triple click,
  // start of selection drag, start of text drag, new cursor
  // (ctrl-click), rectangle drag (alt-drag), or xwin
  // middle-click-paste. Or it might be a click on something we should
  // not interfere with, such as a scrollbar or widget.
  function onMouseDown(e) {
    if (signalDOMEvent(this, e)) return;
    var cm = this, display = cm.display;
    display.shift = e.shiftKey;

    if (eventInWidget(display, e)) {
      if (!webkit) {
        // Briefly turn off draggability, to allow widgets to do
        // normal dragging things.
        display.scroller.draggable = false;
        setTimeout(function(){display.scroller.draggable = true;}, 100);
      }
      return;
    }
    if (clickInGutter(cm, e)) return;
    var start = posFromMouse(cm, e);
    window.focus();

    switch (e_button(e)) {
    case 1:
      if (start)
        leftButtonDown(cm, e, start);
      else if (e_target(e) == display.scroller)
        e_preventDefault(e);
      break;
    case 2:
      if (webkit) cm.state.lastMiddleDown = +new Date;
      if (start) extendSelection(cm.doc, start);
      setTimeout(bind(focusInput, cm), 20);
      e_preventDefault(e);
      break;
    case 3:
      if (captureRightClick) onContextMenu(cm, e);
      break;
    }
  }

  var lastClick, lastDoubleClick;
  function leftButtonDown(cm, e, start) {
    setTimeout(bind(ensureFocus, cm), 0);

    var now = +new Date, type;
    if (lastDoubleClick && lastDoubleClick.time > now - 400 && cmp(lastDoubleClick.pos, start) == 0) {
      type = "triple";
    } else if (lastClick && lastClick.time > now - 400 && cmp(lastClick.pos, start) == 0) {
      type = "double";
      lastDoubleClick = {time: now, pos: start};
    } else {
      type = "single";
      lastClick = {time: now, pos: start};
    }

    var sel = cm.doc.sel, modifier = mac ? e.metaKey : e.ctrlKey;
    if (cm.options.dragDrop && dragAndDrop && !isReadOnly(cm) &&
        type == "single" && sel.contains(start) > -1 && sel.somethingSelected())
      leftButtonStartDrag(cm, e, start, modifier);
    else
      leftButtonSelect(cm, e, start, type, modifier);
  }

  // Start a text drag. When it ends, see if any dragging actually
  // happen, and treat as a click if it didn't.
  function leftButtonStartDrag(cm, e, start, modifier) {
    var display = cm.display;
    var dragEnd = operation(cm, function(e2) {
      if (webkit) display.scroller.draggable = false;
      cm.state.draggingText = false;
      off(document, "mouseup", dragEnd);
      off(display.scroller, "drop", dragEnd);
      if (Math.abs(e.clientX - e2.clientX) + Math.abs(e.clientY - e2.clientY) < 10) {
        e_preventDefault(e2);
        if (!modifier)
          extendSelection(cm.doc, start);
        focusInput(cm);
        // Work around unexplainable focus problem in IE9 (#2127)
        if (ie && ie_version == 9)
          setTimeout(function() {document.body.focus(); focusInput(cm);}, 20);
      }
    });
    // Let the drag handler handle this.
    if (webkit) display.scroller.draggable = true;
    cm.state.draggingText = dragEnd;
    // IE's approach to draggable
    if (display.scroller.dragDrop) display.scroller.dragDrop();
    on(document, "mouseup", dragEnd);
    on(display.scroller, "drop", dragEnd);
  }

  // Normal selection, as opposed to text dragging.
  function leftButtonSelect(cm, e, start, type, addNew) {
    var display = cm.display, doc = cm.doc;
    e_preventDefault(e);

    var ourRange, ourIndex, startSel = doc.sel;
    if (addNew && !e.shiftKey) {
      ourIndex = doc.sel.contains(start);
      if (ourIndex > -1)
        ourRange = doc.sel.ranges[ourIndex];
      else
        ourRange = new Range(start, start);
    } else {
      ourRange = doc.sel.primary();
    }

    if (e.altKey) {
      type = "rect";
      if (!addNew) ourRange = new Range(start, start);
      start = posFromMouse(cm, e, true, true);
      ourIndex = -1;
    } else if (type == "double") {
      var word = findWordAt(cm, start);
      if (cm.display.shift || doc.extend)
        ourRange = extendRange(doc, ourRange, word.anchor, word.head);
      else
        ourRange = word;
    } else if (type == "triple") {
      var line = new Range(Pos(start.line, 0), clipPos(doc, Pos(start.line + 1, 0)));
      if (cm.display.shift || doc.extend)
        ourRange = extendRange(doc, ourRange, line.anchor, line.head);
      else
        ourRange = line;
    } else {
      ourRange = extendRange(doc, ourRange, start);
    }

    if (!addNew) {
      ourIndex = 0;
      setSelection(doc, new Selection([ourRange], 0), sel_mouse);
      startSel = doc.sel;
    } else if (ourIndex > -1) {
      replaceOneSelection(doc, ourIndex, ourRange, sel_mouse);
    } else {
      ourIndex = doc.sel.ranges.length;
      setSelection(doc, normalizeSelection(doc.sel.ranges.concat([ourRange]), ourIndex),
                   {scroll: false, origin: "*mouse"});
    }

    var lastPos = start;
    function extendTo(pos) {
      if (cmp(lastPos, pos) == 0) return;
      lastPos = pos;

      if (type == "rect") {
        var ranges = [], tabSize = cm.options.tabSize;
        var startCol = countColumn(getLine(doc, start.line).text, start.ch, tabSize);
        var posCol = countColumn(getLine(doc, pos.line).text, pos.ch, tabSize);
        var left = Math.min(startCol, posCol), right = Math.max(startCol, posCol);
        for (var line = Math.min(start.line, pos.line), end = Math.min(cm.lastLine(), Math.max(start.line, pos.line));
             line <= end; line++) {
          var text = getLine(doc, line).text, leftPos = findColumn(text, left, tabSize);
          if (left == right)
            ranges.push(new Range(Pos(line, leftPos), Pos(line, leftPos)));
          else if (text.length > leftPos)
            ranges.push(new Range(Pos(line, leftPos), Pos(line, findColumn(text, right, tabSize))));
        }
        if (!ranges.length) ranges.push(new Range(start, start));
        setSelection(doc, normalizeSelection(startSel.ranges.slice(0, ourIndex).concat(ranges), ourIndex),
                     {origin: "*mouse", scroll: false});
        cm.scrollIntoView(pos);
      } else {
        var oldRange = ourRange;
        var anchor = oldRange.anchor, head = pos;
        if (type != "single") {
          if (type == "double")
            var range = findWordAt(cm, pos);
          else
            var range = new Range(Pos(pos.line, 0), clipPos(doc, Pos(pos.line + 1, 0)));
          if (cmp(range.anchor, anchor) > 0) {
            head = range.head;
            anchor = minPos(oldRange.from(), range.anchor);
          } else {
            head = range.anchor;
            anchor = maxPos(oldRange.to(), range.head);
          }
        }
        var ranges = startSel.ranges.slice(0);
        ranges[ourIndex] = new Range(clipPos(doc, anchor), head);
        setSelection(doc, normalizeSelection(ranges, ourIndex), sel_mouse);
      }
    }

    var editorSize = display.wrapper.getBoundingClientRect();
    // Used to ensure timeout re-tries don't fire when another extend
    // happened in the meantime (clearTimeout isn't reliable -- at
    // least on Chrome, the timeouts still happen even when cleared,
    // if the clear happens after their scheduled firing time).
    var counter = 0;

    function extend(e) {
      var curCount = ++counter;
      var cur = posFromMouse(cm, e, true, type == "rect");
      if (!cur) return;
      if (cmp(cur, lastPos) != 0) {
        ensureFocus(cm);
        extendTo(cur);
        var visible = visibleLines(display, doc);
        if (cur.line >= visible.to || cur.line < visible.from)
          setTimeout(operation(cm, function(){if (counter == curCount) extend(e);}), 150);
      } else {
        var outside = e.clientY < editorSize.top ? -20 : e.clientY > editorSize.bottom ? 20 : 0;
        if (outside) setTimeout(operation(cm, function() {
          if (counter != curCount) return;
          display.scroller.scrollTop += outside;
          extend(e);
        }), 50);
      }
    }

    function done(e) {
      counter = Infinity;
      e_preventDefault(e);
      focusInput(cm);
      off(document, "mousemove", move);
      off(document, "mouseup", up);
      doc.history.lastSelOrigin = null;
    }

    var move = operation(cm, function(e) {
      if (!e_button(e)) done(e);
      else extend(e);
    });
    var up = operation(cm, done);
    on(document, "mousemove", move);
    on(document, "mouseup", up);
  }

  // Determines whether an event happened in the gutter, and fires the
  // handlers for the corresponding event.
  function gutterEvent(cm, e, type, prevent, signalfn) {
    try { var mX = e.clientX, mY = e.clientY; }
    catch(e) { return false; }
    if (mX >= Math.floor(cm.display.gutters.getBoundingClientRect().right)) return false;
    if (prevent) e_preventDefault(e);

    var display = cm.display;
    var lineBox = display.lineDiv.getBoundingClientRect();

    if (mY > lineBox.bottom || !hasHandler(cm, type)) return e_defaultPrevented(e);
    mY -= lineBox.top - display.viewOffset;

    for (var i = 0; i < cm.options.gutters.length; ++i) {
      var g = display.gutters.childNodes[i];
      if (g && g.getBoundingClientRect().right >= mX) {
        var line = lineAtHeight(cm.doc, mY);
        var gutter = cm.options.gutters[i];
        signalfn(cm, type, cm, line, gutter, e);
        return e_defaultPrevented(e);
      }
    }
  }

  function clickInGutter(cm, e) {
    return gutterEvent(cm, e, "gutterClick", true, signalLater);
  }

  // Kludge to work around strange IE behavior where it'll sometimes
  // re-fire a series of drag-related events right after the drop (#1551)
  var lastDrop = 0;

  function onDrop(e) {
    var cm = this;
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e))
      return;
    e_preventDefault(e);
    if (ie) lastDrop = +new Date;
    var pos = posFromMouse(cm, e, true), files = e.dataTransfer.files;
    if (!pos || isReadOnly(cm)) return;
    // Might be a file drop, in which case we simply extract the text
    // and insert it.
    if (files && files.length && window.FileReader && window.File) {
      var n = files.length, text = Array(n), read = 0;
      var loadFile = function(file, i) {
        var reader = new FileReader;
        reader.onload = operation(cm, function() {
          text[i] = reader.result;
          if (++read == n) {
            pos = clipPos(cm.doc, pos);
            var change = {from: pos, to: pos, text: splitLines(text.join("\n")), origin: "paste"};
            makeChange(cm.doc, change);
            setSelectionReplaceHistory(cm.doc, simpleSelection(pos, changeEnd(change)));
          }
        });
        reader.readAsText(file);
      };
      for (var i = 0; i < n; ++i) loadFile(files[i], i);
    } else { // Normal drop
      // Don't do a replace if the drop happened inside of the selected text.
      if (cm.state.draggingText && cm.doc.sel.contains(pos) > -1) {
        cm.state.draggingText(e);
        // Ensure the editor is re-focused
        setTimeout(bind(focusInput, cm), 20);
        return;
      }
      try {
        var text = e.dataTransfer.getData("Text");
        if (text) {
          if (cm.state.draggingText && !(mac ? e.metaKey : e.ctrlKey))
            var selected = cm.listSelections();
          setSelectionNoUndo(cm.doc, simpleSelection(pos, pos));
          if (selected) for (var i = 0; i < selected.length; ++i)
            replaceRange(cm.doc, "", selected[i].anchor, selected[i].head, "drag");
          cm.replaceSelection(text, "around", "paste");
          focusInput(cm);
        }
      }
      catch(e){}
    }
  }

  function onDragStart(cm, e) {
    if (ie && (!cm.state.draggingText || +new Date - lastDrop < 100)) { e_stop(e); return; }
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e)) return;

    e.dataTransfer.setData("Text", cm.getSelection());

    // Use dummy image instead of default browsers image.
    // Recent Safari (~6.0.2) have a tendency to segfault when this happens, so we don't do it there.
    if (e.dataTransfer.setDragImage && !safari) {
      var img = elt("img", null, null, "position: fixed; left: 0; top: 0;");
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
      if (presto) {
        img.width = img.height = 1;
        cm.display.wrapper.appendChild(img);
        // Force a relayout, or Opera won't use our image for some obscure reason
        img._top = img.offsetTop;
      }
      e.dataTransfer.setDragImage(img, 0, 0);
      if (presto) img.parentNode.removeChild(img);
    }
  }

  // SCROLL EVENTS

  // Sync the scrollable area and scrollbars, ensure the viewport
  // covers the visible area.
  function setScrollTop(cm, val) {
    if (Math.abs(cm.doc.scrollTop - val) < 2) return;
    cm.doc.scrollTop = val;
    if (!gecko) updateDisplay(cm, {top: val});
    if (cm.display.scroller.scrollTop != val) cm.display.scroller.scrollTop = val;
    if (cm.display.scrollbarV.scrollTop != val) cm.display.scrollbarV.scrollTop = val;
    if (gecko) updateDisplay(cm);
    startWorker(cm, 100);
  }
  // Sync scroller and scrollbar, ensure the gutter elements are
  // aligned.
  function setScrollLeft(cm, val, isScroller) {
    if (isScroller ? val == cm.doc.scrollLeft : Math.abs(cm.doc.scrollLeft - val) < 2) return;
    val = Math.min(val, cm.display.scroller.scrollWidth - cm.display.scroller.clientWidth);
    cm.doc.scrollLeft = val;
    alignHorizontally(cm);
    if (cm.display.scroller.scrollLeft != val) cm.display.scroller.scrollLeft = val;
    if (cm.display.scrollbarH.scrollLeft != val) cm.display.scrollbarH.scrollLeft = val;
  }

  // Since the delta values reported on mouse wheel events are
  // unstandardized between browsers and even browser versions, and
  // generally horribly unpredictable, this code starts by measuring
  // the scroll effect that the first few mouse wheel events have,
  // and, from that, detects the way it can convert deltas to pixel
  // offsets afterwards.
  //
  // The reason we want to know the amount a wheel event will scroll
  // is that it gives us a chance to update the display before the
  // actual scrolling happens, reducing flickering.

  var wheelSamples = 0, wheelPixelsPerUnit = null;
  // Fill in a browser-detected starting value on browsers where we
  // know one. These don't have to be accurate -- the result of them
  // being wrong would just be a slight flicker on the first wheel
  // scroll (if it is large enough).
  if (ie) wheelPixelsPerUnit = -.53;
  else if (gecko) wheelPixelsPerUnit = 15;
  else if (chrome) wheelPixelsPerUnit = -.7;
  else if (safari) wheelPixelsPerUnit = -1/3;

  function onScrollWheel(cm, e) {
    var dx = e.wheelDeltaX, dy = e.wheelDeltaY;
    if (dx == null && e.detail && e.axis == e.HORIZONTAL_AXIS) dx = e.detail;
    if (dy == null && e.detail && e.axis == e.VERTICAL_AXIS) dy = e.detail;
    else if (dy == null) dy = e.wheelDelta;

    var display = cm.display, scroll = display.scroller;
    // Quit if there's nothing to scroll here
    if (!(dx && scroll.scrollWidth > scroll.clientWidth ||
          dy && scroll.scrollHeight > scroll.clientHeight)) return;

    // Webkit browsers on OS X abort momentum scrolls when the target
    // of the scroll event is removed from the scrollable element.
    // This hack (see related code in patchDisplay) makes sure the
    // element is kept around.
    if (dy && mac && webkit) {
      outer: for (var cur = e.target, view = display.view; cur != scroll; cur = cur.parentNode) {
        for (var i = 0; i < view.length; i++) {
          if (view[i].node == cur) {
            cm.display.currentWheelTarget = cur;
            break outer;
          }
        }
      }
    }

    // On some browsers, horizontal scrolling will cause redraws to
    // happen before the gutter has been realigned, causing it to
    // wriggle around in a most unseemly way. When we have an
    // estimated pixels/delta value, we just handle horizontal
    // scrolling entirely here. It'll be slightly off from native, but
    // better than glitching out.
    if (dx && !gecko && !presto && wheelPixelsPerUnit != null) {
      if (dy)
        setScrollTop(cm, Math.max(0, Math.min(scroll.scrollTop + dy * wheelPixelsPerUnit, scroll.scrollHeight - scroll.clientHeight)));
      setScrollLeft(cm, Math.max(0, Math.min(scroll.scrollLeft + dx * wheelPixelsPerUnit, scroll.scrollWidth - scroll.clientWidth)));
      e_preventDefault(e);
      display.wheelStartX = null; // Abort measurement, if in progress
      return;
    }

    // 'Project' the visible viewport to cover the area that is being
    // scrolled into view (if we know enough to estimate it).
    if (dy && wheelPixelsPerUnit != null) {
      var pixels = dy * wheelPixelsPerUnit;
      var top = cm.doc.scrollTop, bot = top + display.wrapper.clientHeight;
      if (pixels < 0) top = Math.max(0, top + pixels - 50);
      else bot = Math.min(cm.doc.height, bot + pixels + 50);
      updateDisplay(cm, {top: top, bottom: bot});
    }

    if (wheelSamples < 20) {
      if (display.wheelStartX == null) {
        display.wheelStartX = scroll.scrollLeft; display.wheelStartY = scroll.scrollTop;
        display.wheelDX = dx; display.wheelDY = dy;
        setTimeout(function() {
          if (display.wheelStartX == null) return;
          var movedX = scroll.scrollLeft - display.wheelStartX;
          var movedY = scroll.scrollTop - display.wheelStartY;
          var sample = (movedY && display.wheelDY && movedY / display.wheelDY) ||
            (movedX && display.wheelDX && movedX / display.wheelDX);
          display.wheelStartX = display.wheelStartY = null;
          if (!sample) return;
          wheelPixelsPerUnit = (wheelPixelsPerUnit * wheelSamples + sample) / (wheelSamples + 1);
          ++wheelSamples;
        }, 200);
      } else {
        display.wheelDX += dx; display.wheelDY += dy;
      }
    }
  }

  // KEY EVENTS

  // Run a handler that was bound to a key.
  function doHandleBinding(cm, bound, dropShift) {
    if (typeof bound == "string") {
      bound = commands[bound];
      if (!bound) return false;
    }
    // Ensure previous input has been read, so that the handler sees a
    // consistent view of the document
    if (cm.display.pollingFast && readInput(cm)) cm.display.pollingFast = false;
    var prevShift = cm.display.shift, done = false;
    try {
      if (isReadOnly(cm)) cm.state.suppressEdits = true;
      if (dropShift) cm.display.shift = false;
      done = bound(cm) != Pass;
    } finally {
      cm.display.shift = prevShift;
      cm.state.suppressEdits = false;
    }
    return done;
  }

  // Collect the currently active keymaps.
  function allKeyMaps(cm) {
    var maps = cm.state.keyMaps.slice(0);
    if (cm.options.extraKeys) maps.push(cm.options.extraKeys);
    maps.push(cm.options.keyMap);
    return maps;
  }

  var maybeTransition;
  // Handle a key from the keydown event.
  function handleKeyBinding(cm, e) {
    // Handle automatic keymap transitions
    var startMap = getKeyMap(cm.options.keyMap), next = startMap.auto;
    clearTimeout(maybeTransition);
    if (next && !isModifierKey(e)) maybeTransition = setTimeout(function() {
      if (getKeyMap(cm.options.keyMap) == startMap) {
        cm.options.keyMap = (next.call ? next.call(null, cm) : next);
        keyMapChanged(cm);
      }
    }, 50);

    var name = keyName(e, true), handled = false;
    if (!name) return false;
    var keymaps = allKeyMaps(cm);

    if (e.shiftKey) {
      // First try to resolve full name (including 'Shift-'). Failing
      // that, see if there is a cursor-motion command (starting with
      // 'go') bound to the keyname without 'Shift-'.
      handled = lookupKey("Shift-" + name, keymaps, function(b) {return doHandleBinding(cm, b, true);})
             || lookupKey(name, keymaps, function(b) {
                  if (typeof b == "string" ? /^go[A-Z]/.test(b) : b.motion)
                    return doHandleBinding(cm, b);
                });
    } else {
      handled = lookupKey(name, keymaps, function(b) { return doHandleBinding(cm, b); });
    }

    if (handled) {
      e_preventDefault(e);
      restartBlink(cm);
      signalLater(cm, "keyHandled", cm, name, e);
    }
    return handled;
  }

  // Handle a key from the keypress event
  function handleCharBinding(cm, e, ch) {
    var handled = lookupKey("'" + ch + "'", allKeyMaps(cm),
                            function(b) { return doHandleBinding(cm, b, true); });
    if (handled) {
      e_preventDefault(e);
      restartBlink(cm);
      signalLater(cm, "keyHandled", cm, "'" + ch + "'", e);
    }
    return handled;
  }

  var lastStoppedKey = null;
  function onKeyDown(e) {
    var cm = this;
    ensureFocus(cm);
    if (signalDOMEvent(cm, e)) return;
    // IE does strange things with escape.
    if (ie && ie_version < 11 && e.keyCode == 27) e.returnValue = false;
    var code = e.keyCode;
    cm.display.shift = code == 16 || e.shiftKey;
    var handled = handleKeyBinding(cm, e);
    if (presto) {
      lastStoppedKey = handled ? code : null;
      // Opera has no cut event... we try to at least catch the key combo
      if (!handled && code == 88 && !hasCopyEvent && (mac ? e.metaKey : e.ctrlKey))
        cm.replaceSelection("", null, "cut");
    }

    // Turn mouse into crosshair when Alt is held on Mac.
    if (code == 18 && !/\bCodeMirror-crosshair\b/.test(cm.display.lineDiv.className))
      showCrossHair(cm);
  }

  function showCrossHair(cm) {
    var lineDiv = cm.display.lineDiv;
    addClass(lineDiv, "CodeMirror-crosshair");

    function up(e) {
      if (e.keyCode == 18 || !e.altKey) {
        rmClass(lineDiv, "CodeMirror-crosshair");
        off(document, "keyup", up);
        off(document, "mouseover", up);
      }
    }
    on(document, "keyup", up);
    on(document, "mouseover", up);
  }

  function onKeyUp(e) {
    if (signalDOMEvent(this, e)) return;
    if (e.keyCode == 16) this.doc.sel.shift = false;
  }

  function onKeyPress(e) {
    var cm = this;
    if (signalDOMEvent(cm, e) || e.ctrlKey || mac && e.metaKey) return;
    var keyCode = e.keyCode, charCode = e.charCode;
    if (presto && keyCode == lastStoppedKey) {lastStoppedKey = null; e_preventDefault(e); return;}
    if (((presto && (!e.which || e.which < 10)) || khtml) && handleKeyBinding(cm, e)) return;
    var ch = String.fromCharCode(charCode == null ? keyCode : charCode);
    if (handleCharBinding(cm, e, ch)) return;
    if (ie && ie_version >= 9) cm.display.inputHasSelection = null;
    fastPoll(cm);
  }

  // FOCUS/BLUR EVENTS

  function onFocus(cm) {
    if (cm.options.readOnly == "nocursor") return;
    if (!cm.state.focused) {
      signal(cm, "focus", cm);
      cm.state.focused = true;
      addClass(cm.display.wrapper, "CodeMirror-focused");
      // The prevInput test prevents this from firing when a context
      // menu is closed (since the resetInput would kill the
      // select-all detection hack)
      if (!cm.curOp && cm.display.selForContextMenu != cm.doc.sel) {
        resetInput(cm);
        if (webkit) setTimeout(bind(resetInput, cm, true), 0); // Issue #1730
      }
    }
    slowPoll(cm);
    restartBlink(cm);
  }
  function onBlur(cm) {
    if (cm.state.focused) {
      signal(cm, "blur", cm);
      cm.state.focused = false;
      rmClass(cm.display.wrapper, "CodeMirror-focused");
    }
    clearInterval(cm.display.blinker);
    setTimeout(function() {if (!cm.state.focused) cm.display.shift = false;}, 150);
  }

  // CONTEXT MENU HANDLING

  // To make the context menu work, we need to briefly unhide the
  // textarea (making it as unobtrusive as possible) to let the
  // right-click take effect on it.
  function onContextMenu(cm, e) {
    if (signalDOMEvent(cm, e, "contextmenu")) return;
    var display = cm.display;
    if (eventInWidget(display, e) || contextMenuInGutter(cm, e)) return;

    var pos = posFromMouse(cm, e), scrollPos = display.scroller.scrollTop;
    if (!pos || presto) return; // Opera is difficult.

    // Reset the current text selection only if the click is done outside of the selection
    // and 'resetSelectionOnContextMenu' option is true.
    var reset = cm.options.resetSelectionOnContextMenu;
    if (reset && cm.doc.sel.contains(pos) == -1)
      operation(cm, setSelection)(cm.doc, simpleSelection(pos), sel_dontScroll);

    var oldCSS = display.input.style.cssText;
    display.inputDiv.style.position = "absolute";
    display.input.style.cssText = "position: fixed; width: 30px; height: 30px; top: " + (e.clientY - 5) +
      "px; left: " + (e.clientX - 5) + "px; z-index: 1000; background: " +
      (ie ? "rgba(255, 255, 255, .05)" : "transparent") +
      "; outline: none; border-width: 0; outline: none; overflow: hidden; opacity: .05; filter: alpha(opacity=5);";
    focusInput(cm);
    resetInput(cm);
    // Adds "Select all" to context menu in FF
    if (!cm.somethingSelected()) display.input.value = display.prevInput = " ";
    display.selForContextMenu = cm.doc.sel;
    clearTimeout(display.detectingSelectAll);

    // Select-all will be greyed out if there's nothing to select, so
    // this adds a zero-width space so that we can later check whether
    // it got selected.
    function prepareSelectAllHack() {
      if (display.input.selectionStart != null) {
        var selected = cm.somethingSelected();
        var extval = display.input.value = "\u200b" + (selected ? display.input.value : "");
        display.prevInput = selected ? "" : "\u200b";
        display.input.selectionStart = 1; display.input.selectionEnd = extval.length;
        // Re-set this, in case some other handler touched the
        // selection in the meantime.
        display.selForContextMenu = cm.doc.sel;
      }
    }
    function rehide() {
      display.inputDiv.style.position = "relative";
      display.input.style.cssText = oldCSS;
      if (ie && ie_version < 9) display.scrollbarV.scrollTop = display.scroller.scrollTop = scrollPos;
      slowPoll(cm);

      // Try to detect the user choosing select-all
      if (display.input.selectionStart != null) {
        if (!ie || (ie && ie_version < 9)) prepareSelectAllHack();
        var i = 0, poll = function() {
          if (display.selForContextMenu == cm.doc.sel && display.input.selectionStart == 0)
            operation(cm, commands.selectAll)(cm);
          else if (i++ < 10) display.detectingSelectAll = setTimeout(poll, 500);
          else resetInput(cm);
        };
        display.detectingSelectAll = setTimeout(poll, 200);
      }
    }

    if (ie && ie_version >= 9) prepareSelectAllHack();
    if (captureRightClick) {
      e_stop(e);
      var mouseup = function() {
        off(window, "mouseup", mouseup);
        setTimeout(rehide, 20);
      };
      on(window, "mouseup", mouseup);
    } else {
      setTimeout(rehide, 50);
    }
  }

  function contextMenuInGutter(cm, e) {
    if (!hasHandler(cm, "gutterContextMenu")) return false;
    return gutterEvent(cm, e, "gutterContextMenu", false, signal);
  }

  // UPDATING

  // Compute the position of the end of a change (its 'to' property
  // refers to the pre-change end).
  var changeEnd = CodeMirror.changeEnd = function(change) {
    if (!change.text) return change.to;
    return Pos(change.from.line + change.text.length - 1,
               lst(change.text).length + (change.text.length == 1 ? change.from.ch : 0));
  };

  // Adjust a position to refer to the post-change position of the
  // same text, or the end of the change if the change covers it.
  function adjustForChange(pos, change) {
    if (cmp(pos, change.from) < 0) return pos;
    if (cmp(pos, change.to) <= 0) return changeEnd(change);

    var line = pos.line + change.text.length - (change.to.line - change.from.line) - 1, ch = pos.ch;
    if (pos.line == change.to.line) ch += changeEnd(change).ch - change.to.ch;
    return Pos(line, ch);
  }

  function computeSelAfterChange(doc, change) {
    var out = [];
    for (var i = 0; i < doc.sel.ranges.length; i++) {
      var range = doc.sel.ranges[i];
      out.push(new Range(adjustForChange(range.anchor, change),
                         adjustForChange(range.head, change)));
    }
    return normalizeSelection(out, doc.sel.primIndex);
  }

  function offsetPos(pos, old, nw) {
    if (pos.line == old.line)
      return Pos(nw.line, pos.ch - old.ch + nw.ch);
    else
      return Pos(nw.line + (pos.line - old.line), pos.ch);
  }

  // Used by replaceSelections to allow moving the selection to the
  // start or around the replaced test. Hint may be "start" or "around".
  function computeReplacedSel(doc, changes, hint) {
    var out = [];
    var oldPrev = Pos(doc.first, 0), newPrev = oldPrev;
    for (var i = 0; i < changes.length; i++) {
      var change = changes[i];
      var from = offsetPos(change.from, oldPrev, newPrev);
      var to = offsetPos(changeEnd(change), oldPrev, newPrev);
      oldPrev = change.to;
      newPrev = to;
      if (hint == "around") {
        var range = doc.sel.ranges[i], inv = cmp(range.head, range.anchor) < 0;
        out[i] = new Range(inv ? to : from, inv ? from : to);
      } else {
        out[i] = new Range(from, from);
      }
    }
    return new Selection(out, doc.sel.primIndex);
  }

  // Allow "beforeChange" event handlers to influence a change
  function filterChange(doc, change, update) {
    var obj = {
      canceled: false,
      from: change.from,
      to: change.to,
      text: change.text,
      origin: change.origin,
      cancel: function() { this.canceled = true; }
    };
    if (update) obj.update = function(from, to, text, origin) {
      if (from) this.from = clipPos(doc, from);
      if (to) this.to = clipPos(doc, to);
      if (text) this.text = text;
      if (origin !== undefined) this.origin = origin;
    };
    signal(doc, "beforeChange", doc, obj);
    if (doc.cm) signal(doc.cm, "beforeChange", doc.cm, obj);

    if (obj.canceled) return null;
    return {from: obj.from, to: obj.to, text: obj.text, origin: obj.origin};
  }

  // Apply a change to a document, and add it to the document's
  // history, and propagating it to all linked documents.
  function makeChange(doc, change, ignoreReadOnly) {
    if (doc.cm) {
      if (!doc.cm.curOp) return operation(doc.cm, makeChange)(doc, change, ignoreReadOnly);
      if (doc.cm.state.suppressEdits) return;
    }

    if (hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange")) {
      change = filterChange(doc, change, true);
      if (!change) return;
    }

    // Possibly split or suppress the update based on the presence
    // of read-only spans in its range.
    var split = sawReadOnlySpans && !ignoreReadOnly && removeReadOnlyRanges(doc, change.from, change.to);
    if (split) {
      for (var i = split.length - 1; i >= 0; --i)
        makeChangeInner(doc, {from: split[i].from, to: split[i].to, text: i ? [""] : change.text});
    } else {
      makeChangeInner(doc, change);
    }
  }

  function makeChangeInner(doc, change) {
    if (change.text.length == 1 && change.text[0] == "" && cmp(change.from, change.to) == 0) return;
    var selAfter = computeSelAfterChange(doc, change);
    addChangeToHistory(doc, change, selAfter, doc.cm ? doc.cm.curOp.id : NaN);

    makeChangeSingleDoc(doc, change, selAfter, stretchSpansOverChange(doc, change));
    var rebased = [];

    linkedDocs(doc, function(doc, sharedHist) {
      if (!sharedHist && indexOf(rebased, doc.history) == -1) {
        rebaseHist(doc.history, change);
        rebased.push(doc.history);
      }
      makeChangeSingleDoc(doc, change, null, stretchSpansOverChange(doc, change));
    });
  }

  // Revert a change stored in a document's history.
  function makeChangeFromHistory(doc, type, allowSelectionOnly) {
    if (doc.cm && doc.cm.state.suppressEdits) return;

    var hist = doc.history, event, selAfter = doc.sel;
    var source = type == "undo" ? hist.done : hist.undone, dest = type == "undo" ? hist.undone : hist.done;

    // Verify that there is a useable event (so that ctrl-z won't
    // needlessly clear selection events)
    for (var i = 0; i < source.length; i++) {
      event = source[i];
      if (allowSelectionOnly ? event.ranges && !event.equals(doc.sel) : !event.ranges)
        break;
    }
    if (i == source.length) return;
    hist.lastOrigin = hist.lastSelOrigin = null;

    for (;;) {
      event = source.pop();
      if (event.ranges) {
        pushSelectionToHistory(event, dest);
        if (allowSelectionOnly && !event.equals(doc.sel)) {
          setSelection(doc, event, {clearRedo: false});
          return;
        }
        selAfter = event;
      }
      else break;
    }

    // Build up a reverse change object to add to the opposite history
    // stack (redo when undoing, and vice versa).
    var antiChanges = [];
    pushSelectionToHistory(selAfter, dest);
    dest.push({changes: antiChanges, generation: hist.generation});
    hist.generation = event.generation || ++hist.maxGeneration;

    var filter = hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange");

    for (var i = event.changes.length - 1; i >= 0; --i) {
      var change = event.changes[i];
      change.origin = type;
      if (filter && !filterChange(doc, change, false)) {
        source.length = 0;
        return;
      }

      antiChanges.push(historyChangeFromChange(doc, change));

      var after = i ? computeSelAfterChange(doc, change, null) : lst(source);
      makeChangeSingleDoc(doc, change, after, mergeOldSpans(doc, change));
      if (!i && doc.cm) doc.cm.scrollIntoView(change);
      var rebased = [];

      // Propagate to the linked documents
      linkedDocs(doc, function(doc, sharedHist) {
        if (!sharedHist && indexOf(rebased, doc.history) == -1) {
          rebaseHist(doc.history, change);
          rebased.push(doc.history);
        }
        makeChangeSingleDoc(doc, change, null, mergeOldSpans(doc, change));
      });
    }
  }

  // Sub-views need their line numbers shifted when text is added
  // above or below them in the parent document.
  function shiftDoc(doc, distance) {
    if (distance == 0) return;
    doc.first += distance;
    doc.sel = new Selection(map(doc.sel.ranges, function(range) {
      return new Range(Pos(range.anchor.line + distance, range.anchor.ch),
                       Pos(range.head.line + distance, range.head.ch));
    }), doc.sel.primIndex);
    if (doc.cm) {
      regChange(doc.cm, doc.first, doc.first - distance, distance);
      for (var d = doc.cm.display, l = d.viewFrom; l < d.viewTo; l++)
        regLineChange(doc.cm, l, "gutter");
    }
  }

  // More lower-level change function, handling only a single document
  // (not linked ones).
  function makeChangeSingleDoc(doc, change, selAfter, spans) {
    if (doc.cm && !doc.cm.curOp)
      return operation(doc.cm, makeChangeSingleDoc)(doc, change, selAfter, spans);

    if (change.to.line < doc.first) {
      shiftDoc(doc, change.text.length - 1 - (change.to.line - change.from.line));
      return;
    }
    if (change.from.line > doc.lastLine()) return;

    // Clip the change to the size of this doc
    if (change.from.line < doc.first) {
      var shift = change.text.length - 1 - (doc.first - change.from.line);
      shiftDoc(doc, shift);
      change = {from: Pos(doc.first, 0), to: Pos(change.to.line + shift, change.to.ch),
                text: [lst(change.text)], origin: change.origin};
    }
    var last = doc.lastLine();
    if (change.to.line > last) {
      change = {from: change.from, to: Pos(last, getLine(doc, last).text.length),
                text: [change.text[0]], origin: change.origin};
    }

    change.removed = getBetween(doc, change.from, change.to);

    if (!selAfter) selAfter = computeSelAfterChange(doc, change, null);
    if (doc.cm) makeChangeSingleDocInEditor(doc.cm, change, spans);
    else updateDoc(doc, change, spans);
    setSelectionNoUndo(doc, selAfter, sel_dontScroll);
  }

  // Handle the interaction of a change to a document with the editor
  // that this document is part of.
  function makeChangeSingleDocInEditor(cm, change, spans) {
    var doc = cm.doc, display = cm.display, from = change.from, to = change.to;

    var recomputeMaxLength = false, checkWidthStart = from.line;
    if (!cm.options.lineWrapping) {
      checkWidthStart = lineNo(visualLine(getLine(doc, from.line)));
      doc.iter(checkWidthStart, to.line + 1, function(line) {
        if (line == display.maxLine) {
          recomputeMaxLength = true;
          return true;
        }
      });
    }

    if (doc.sel.contains(change.from, change.to) > -1)
      signalCursorActivity(cm);

    updateDoc(doc, change, spans, estimateHeight(cm));

    if (!cm.options.lineWrapping) {
      doc.iter(checkWidthStart, from.line + change.text.length, function(line) {
        var len = lineLength(line);
        if (len > display.maxLineLength) {
          display.maxLine = line;
          display.maxLineLength = len;
          display.maxLineChanged = true;
          recomputeMaxLength = false;
        }
      });
      if (recomputeMaxLength) cm.curOp.updateMaxLine = true;
    }

    // Adjust frontier, schedule worker
    doc.frontier = Math.min(doc.frontier, from.line);
    startWorker(cm, 400);

    var lendiff = change.text.length - (to.line - from.line) - 1;
    // Remember that these lines changed, for updating the display
    if (from.line == to.line && change.text.length == 1 && !isWholeLineUpdate(cm.doc, change))
      regLineChange(cm, from.line, "text");
    else
      regChange(cm, from.line, to.line + 1, lendiff);

    var changesHandler = hasHandler(cm, "changes"), changeHandler = hasHandler(cm, "change");
    if (changeHandler || changesHandler) {
      var obj = {
        from: from, to: to,
        text: change.text,
        removed: change.removed,
        origin: change.origin
      };
      if (changeHandler) signalLater(cm, "change", cm, obj);
      if (changesHandler) (cm.curOp.changeObjs || (cm.curOp.changeObjs = [])).push(obj);
    }
    cm.display.selForContextMenu = null;
  }

  function replaceRange(doc, code, from, to, origin) {
    if (!to) to = from;
    if (cmp(to, from) < 0) { var tmp = to; to = from; from = tmp; }
    if (typeof code == "string") code = splitLines(code);
    makeChange(doc, {from: from, to: to, text: code, origin: origin});
  }

  // SCROLLING THINGS INTO VIEW

  // If an editor sits on the top or bottom of the window, partially
  // scrolled out of view, this ensures that the cursor is visible.
  function maybeScrollWindow(cm, coords) {
    var display = cm.display, box = display.sizer.getBoundingClientRect(), doScroll = null;
    if (coords.top + box.top < 0) doScroll = true;
    else if (coords.bottom + box.top > (window.innerHeight || document.documentElement.clientHeight)) doScroll = false;
    if (doScroll != null && !phantom) {
      var scrollNode = elt("div", "\u200b", null, "position: absolute; top: " +
                           (coords.top - display.viewOffset - paddingTop(cm.display)) + "px; height: " +
                           (coords.bottom - coords.top + scrollerCutOff) + "px; left: " +
                           coords.left + "px; width: 2px;");
      cm.display.lineSpace.appendChild(scrollNode);
      scrollNode.scrollIntoView(doScroll);
      cm.display.lineSpace.removeChild(scrollNode);
    }
  }

  // Scroll a given position into view (immediately), verifying that
  // it actually became visible (as line heights are accurately
  // measured, the position of something may 'drift' during drawing).
  function scrollPosIntoView(cm, pos, end, margin) {
    if (margin == null) margin = 0;
    for (;;) {
      var changed = false, coords = cursorCoords(cm, pos);
      var endCoords = !end || end == pos ? coords : cursorCoords(cm, end);
      var scrollPos = calculateScrollPos(cm, Math.min(coords.left, endCoords.left),
                                         Math.min(coords.top, endCoords.top) - margin,
                                         Math.max(coords.left, endCoords.left),
                                         Math.max(coords.bottom, endCoords.bottom) + margin);
      var startTop = cm.doc.scrollTop, startLeft = cm.doc.scrollLeft;
      if (scrollPos.scrollTop != null) {
        setScrollTop(cm, scrollPos.scrollTop);
        if (Math.abs(cm.doc.scrollTop - startTop) > 1) changed = true;
      }
      if (scrollPos.scrollLeft != null) {
        setScrollLeft(cm, scrollPos.scrollLeft);
        if (Math.abs(cm.doc.scrollLeft - startLeft) > 1) changed = true;
      }
      if (!changed) return coords;
    }
  }

  // Scroll a given set of coordinates into view (immediately).
  function scrollIntoView(cm, x1, y1, x2, y2) {
    var scrollPos = calculateScrollPos(cm, x1, y1, x2, y2);
    if (scrollPos.scrollTop != null) setScrollTop(cm, scrollPos.scrollTop);
    if (scrollPos.scrollLeft != null) setScrollLeft(cm, scrollPos.scrollLeft);
  }

  // Calculate a new scroll position needed to scroll the given
  // rectangle into view. Returns an object with scrollTop and
  // scrollLeft properties. When these are undefined, the
  // vertical/horizontal position does not need to be adjusted.
  function calculateScrollPos(cm, x1, y1, x2, y2) {
    var display = cm.display, snapMargin = textHeight(cm.display);
    if (y1 < 0) y1 = 0;
    var screentop = cm.curOp && cm.curOp.scrollTop != null ? cm.curOp.scrollTop : display.scroller.scrollTop;
    var screen = display.scroller.clientHeight - scrollerCutOff, result = {};
    var docBottom = cm.doc.height + paddingVert(display);
    var atTop = y1 < snapMargin, atBottom = y2 > docBottom - snapMargin;
    if (y1 < screentop) {
      result.scrollTop = atTop ? 0 : y1;
    } else if (y2 > screentop + screen) {
      var newTop = Math.min(y1, (atBottom ? docBottom : y2) - screen);
      if (newTop != screentop) result.scrollTop = newTop;
    }

    var screenleft = cm.curOp && cm.curOp.scrollLeft != null ? cm.curOp.scrollLeft : display.scroller.scrollLeft;
    var screenw = display.scroller.clientWidth - scrollerCutOff;
    x1 += display.gutters.offsetWidth; x2 += display.gutters.offsetWidth;
    var gutterw = display.gutters.offsetWidth;
    var atLeft = x1 < gutterw + 10;
    if (x1 < screenleft + gutterw || atLeft) {
      if (atLeft) x1 = 0;
      result.scrollLeft = Math.max(0, x1 - 10 - gutterw);
    } else if (x2 > screenw + screenleft - 3) {
      result.scrollLeft = x2 + 10 - screenw;
    }
    return result;
  }

  // Store a relative adjustment to the scroll position in the current
  // operation (to be applied when the operation finishes).
  function addToScrollPos(cm, left, top) {
    if (left != null || top != null) resolveScrollToPos(cm);
    if (left != null)
      cm.curOp.scrollLeft = (cm.curOp.scrollLeft == null ? cm.doc.scrollLeft : cm.curOp.scrollLeft) + left;
    if (top != null)
      cm.curOp.scrollTop = (cm.curOp.scrollTop == null ? cm.doc.scrollTop : cm.curOp.scrollTop) + top;
  }

  // Make sure that at the end of the operation the current cursor is
  // shown.
  function ensureCursorVisible(cm) {
    resolveScrollToPos(cm);
    var cur = cm.getCursor(), from = cur, to = cur;
    if (!cm.options.lineWrapping) {
      from = cur.ch ? Pos(cur.line, cur.ch - 1) : cur;
      to = Pos(cur.line, cur.ch + 1);
    }
    cm.curOp.scrollToPos = {from: from, to: to, margin: cm.options.cursorScrollMargin, isCursor: true};
  }

  // When an operation has its scrollToPos property set, and another
  // scroll action is applied before the end of the operation, this
  // 'simulates' scrolling that position into view in a cheap way, so
  // that the effect of intermediate scroll commands is not ignored.
  function resolveScrollToPos(cm) {
    var range = cm.curOp.scrollToPos;
    if (range) {
      cm.curOp.scrollToPos = null;
      var from = estimateCoords(cm, range.from), to = estimateCoords(cm, range.to);
      var sPos = calculateScrollPos(cm, Math.min(from.left, to.left),
                                    Math.min(from.top, to.top) - range.margin,
                                    Math.max(from.right, to.right),
                                    Math.max(from.bottom, to.bottom) + range.margin);
      cm.scrollTo(sPos.scrollLeft, sPos.scrollTop);
    }
  }

  // API UTILITIES

  // Indent the given line. The how parameter can be "smart",
  // "add"/null, "subtract", or "prev". When aggressive is false
  // (typically set to true for forced single-line indents), empty
  // lines are not indented, and places where the mode returns Pass
  // are left alone.
  function indentLine(cm, n, how, aggressive) {
    var doc = cm.doc, state;
    if (how == null) how = "add";
    if (how == "smart") {
      // Fall back to "prev" when the mode doesn't have an indentation
      // method.
      if (!cm.doc.mode.indent) how = "prev";
      else state = getStateBefore(cm, n);
    }

    var tabSize = cm.options.tabSize;
    var line = getLine(doc, n), curSpace = countColumn(line.text, null, tabSize);
    if (line.stateAfter) line.stateAfter = null;
    var curSpaceString = line.text.match(/^\s*/)[0], indentation;
    if (!aggressive && !/\S/.test(line.text)) {
      indentation = 0;
      how = "not";
    } else if (how == "smart") {
      indentation = cm.doc.mode.indent(state, line.text.slice(curSpaceString.length), line.text);
      if (indentation == Pass) {
        if (!aggressive) return;
        how = "prev";
      }
    }
    if (how == "prev") {
      if (n > doc.first) indentation = countColumn(getLine(doc, n-1).text, null, tabSize);
      else indentation = 0;
    } else if (how == "add") {
      indentation = curSpace + cm.options.indentUnit;
    } else if (how == "subtract") {
      indentation = curSpace - cm.options.indentUnit;
    } else if (typeof how == "number") {
      indentation = curSpace + how;
    }
    indentation = Math.max(0, indentation);

    var indentString = "", pos = 0;
    if (cm.options.indentWithTabs)
      for (var i = Math.floor(indentation / tabSize); i; --i) {pos += tabSize; indentString += "\t";}
    if (pos < indentation) indentString += spaceStr(indentation - pos);

    if (indentString != curSpaceString) {
      replaceRange(cm.doc, indentString, Pos(n, 0), Pos(n, curSpaceString.length), "+input");
    } else {
      // Ensure that, if the cursor was in the whitespace at the start
      // of the line, it is moved to the end of that space.
      for (var i = 0; i < doc.sel.ranges.length; i++) {
        var range = doc.sel.ranges[i];
        if (range.head.line == n && range.head.ch < curSpaceString.length) {
          var pos = Pos(n, curSpaceString.length);
          replaceOneSelection(doc, i, new Range(pos, pos));
          break;
        }
      }
    }
    line.stateAfter = null;
  }

  // Utility for applying a change to a line by handle or number,
  // returning the number and optionally registering the line as
  // changed.
  function changeLine(doc, handle, changeType, op) {
    var no = handle, line = handle;
    if (typeof handle == "number") line = getLine(doc, clipLine(doc, handle));
    else no = lineNo(handle);
    if (no == null) return null;
    if (op(line, no) && doc.cm) regLineChange(doc.cm, no, changeType);
    return line;
  }

  // Helper for deleting text near the selection(s), used to implement
  // backspace, delete, and similar functionality.
  function deleteNearSelection(cm, compute) {
    var ranges = cm.doc.sel.ranges, kill = [];
    // Build up a set of ranges to kill first, merging overlapping
    // ranges.
    for (var i = 0; i < ranges.length; i++) {
      var toKill = compute(ranges[i]);
      while (kill.length && cmp(toKill.from, lst(kill).to) <= 0) {
        var replaced = kill.pop();
        if (cmp(replaced.from, toKill.from) < 0) {
          toKill.from = replaced.from;
          break;
        }
      }
      kill.push(toKill);
    }
    // Next, remove those actual ranges.
    runInOp(cm, function() {
      for (var i = kill.length - 1; i >= 0; i--)
        replaceRange(cm.doc, "", kill[i].from, kill[i].to, "+delete");
      ensureCursorVisible(cm);
    });
  }

  // Used for horizontal relative motion. Dir is -1 or 1 (left or
  // right), unit can be "char", "column" (like char, but doesn't
  // cross line boundaries), "word" (across next word), or "group" (to
  // the start of next group of word or non-word-non-whitespace
  // chars). The visually param controls whether, in right-to-left
  // text, direction 1 means to move towards the next index in the
  // string, or towards the character to the right of the current
  // position. The resulting position will have a hitSide=true
  // property if it reached the end of the document.
  function findPosH(doc, pos, dir, unit, visually) {
    var line = pos.line, ch = pos.ch, origDir = dir;
    var lineObj = getLine(doc, line);
    var possible = true;
    function findNextLine() {
      var l = line + dir;
      if (l < doc.first || l >= doc.first + doc.size) return (possible = false);
      line = l;
      return lineObj = getLine(doc, l);
    }
    function moveOnce(boundToLine) {
      var next = (visually ? moveVisually : moveLogically)(lineObj, ch, dir, true);
      if (next == null) {
        if (!boundToLine && findNextLine()) {
          if (visually) ch = (dir < 0 ? lineRight : lineLeft)(lineObj);
          else ch = dir < 0 ? lineObj.text.length : 0;
        } else return (possible = false);
      } else ch = next;
      return true;
    }

    if (unit == "char") moveOnce();
    else if (unit == "column") moveOnce(true);
    else if (unit == "word" || unit == "group") {
      var sawType = null, group = unit == "group";
      var helper = doc.cm && doc.cm.getHelper(pos, "wordChars");
      for (var first = true;; first = false) {
        if (dir < 0 && !moveOnce(!first)) break;
        var cur = lineObj.text.charAt(ch) || "\n";
        var type = isWordChar(cur, helper) ? "w"
          : group && cur == "\n" ? "n"
          : !group || /\s/.test(cur) ? null
          : "p";
        if (group && !first && !type) type = "s";
        if (sawType && sawType != type) {
          if (dir < 0) {dir = 1; moveOnce();}
          break;
        }

        if (type) sawType = type;
        if (dir > 0 && !moveOnce(!first)) break;
      }
    }
    var result = skipAtomic(doc, Pos(line, ch), origDir, true);
    if (!possible) result.hitSide = true;
    return result;
  }

  // For relative vertical movement. Dir may be -1 or 1. Unit can be
  // "page" or "line". The resulting position will have a hitSide=true
  // property if it reached the end of the document.
  function findPosV(cm, pos, dir, unit) {
    var doc = cm.doc, x = pos.left, y;
    if (unit == "page") {
      var pageSize = Math.min(cm.display.wrapper.clientHeight, window.innerHeight || document.documentElement.clientHeight);
      y = pos.top + dir * (pageSize - (dir < 0 ? 1.5 : .5) * textHeight(cm.display));
    } else if (unit == "line") {
      y = dir > 0 ? pos.bottom + 3 : pos.top - 3;
    }
    for (;;) {
      var target = coordsChar(cm, x, y);
      if (!target.outside) break;
      if (dir < 0 ? y <= 0 : y >= doc.height) { target.hitSide = true; break; }
      y += dir * 5;
    }
    return target;
  }

  // Find the word at the given position (as returned by coordsChar).
  function findWordAt(cm, pos) {
    var doc = cm.doc, line = getLine(doc, pos.line).text;
    var start = pos.ch, end = pos.ch;
    if (line) {
      var helper = cm.getHelper(pos, "wordChars");
      if ((pos.xRel < 0 || end == line.length) && start) --start; else ++end;
      var startChar = line.charAt(start);
      var check = isWordChar(startChar, helper)
        ? function(ch) { return isWordChar(ch, helper); }
        : /\s/.test(startChar) ? function(ch) {return /\s/.test(ch);}
        : function(ch) {return !/\s/.test(ch) && !isWordChar(ch);};
      while (start > 0 && check(line.charAt(start - 1))) --start;
      while (end < line.length && check(line.charAt(end))) ++end;
    }
    return new Range(Pos(pos.line, start), Pos(pos.line, end));
  }

  // EDITOR METHODS

  // The publicly visible API. Note that methodOp(f) means
  // 'wrap f in an operation, performed on its `this` parameter'.

  // This is not the complete set of editor methods. Most of the
  // methods defined on the Doc type are also injected into
  // CodeMirror.prototype, for backwards compatibility and
  // convenience.

  CodeMirror.prototype = {
    constructor: CodeMirror,
    focus: function(){window.focus(); focusInput(this); fastPoll(this);},

    setOption: function(option, value) {
      var options = this.options, old = options[option];
      if (options[option] == value && option != "mode") return;
      options[option] = value;
      if (optionHandlers.hasOwnProperty(option))
        operation(this, optionHandlers[option])(this, value, old);
    },

    getOption: function(option) {return this.options[option];},
    getDoc: function() {return this.doc;},

    addKeyMap: function(map, bottom) {
      this.state.keyMaps[bottom ? "push" : "unshift"](map);
    },
    removeKeyMap: function(map) {
      var maps = this.state.keyMaps;
      for (var i = 0; i < maps.length; ++i)
        if (maps[i] == map || (typeof maps[i] != "string" && maps[i].name == map)) {
          maps.splice(i, 1);
          return true;
        }
    },

    addOverlay: methodOp(function(spec, options) {
      var mode = spec.token ? spec : CodeMirror.getMode(this.options, spec);
      if (mode.startState) throw new Error("Overlays may not be stateful.");
      this.state.overlays.push({mode: mode, modeSpec: spec, opaque: options && options.opaque});
      this.state.modeGen++;
      regChange(this);
    }),
    removeOverlay: methodOp(function(spec) {
      var overlays = this.state.overlays;
      for (var i = 0; i < overlays.length; ++i) {
        var cur = overlays[i].modeSpec;
        if (cur == spec || typeof spec == "string" && cur.name == spec) {
          overlays.splice(i, 1);
          this.state.modeGen++;
          regChange(this);
          return;
        }
      }
    }),

    indentLine: methodOp(function(n, dir, aggressive) {
      if (typeof dir != "string" && typeof dir != "number") {
        if (dir == null) dir = this.options.smartIndent ? "smart" : "prev";
        else dir = dir ? "add" : "subtract";
      }
      if (isLine(this.doc, n)) indentLine(this, n, dir, aggressive);
    }),
    indentSelection: methodOp(function(how) {
      var ranges = this.doc.sel.ranges, end = -1;
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (!range.empty()) {
          var start = Math.max(end, range.from().line);
          var to = range.to();
          end = Math.min(this.lastLine(), to.line - (to.ch ? 0 : 1)) + 1;
          for (var j = start; j < end; ++j)
            indentLine(this, j, how);
        } else if (range.head.line > end) {
          indentLine(this, range.head.line, how, true);
          end = range.head.line;
          if (i == this.doc.sel.primIndex) ensureCursorVisible(this);
        }
      }
    }),

    // Fetch the parser token for a given character. Useful for hacks
    // that want to inspect the mode state (say, for completion).
    getTokenAt: function(pos, precise) {
      var doc = this.doc;
      pos = clipPos(doc, pos);
      var state = getStateBefore(this, pos.line, precise), mode = this.doc.mode;
      var line = getLine(doc, pos.line);
      var stream = new StringStream(line.text, this.options.tabSize);
      while (stream.pos < pos.ch && !stream.eol()) {
        stream.start = stream.pos;
        var style = readToken(mode, stream, state);
      }
      return {start: stream.start,
              end: stream.pos,
              string: stream.current(),
              type: style || null,
              state: state};
    },

    getTokenTypeAt: function(pos) {
      pos = clipPos(this.doc, pos);
      var styles = getLineStyles(this, getLine(this.doc, pos.line));
      var before = 0, after = (styles.length - 1) / 2, ch = pos.ch;
      var type;
      if (ch == 0) type = styles[2];
      else for (;;) {
        var mid = (before + after) >> 1;
        if ((mid ? styles[mid * 2 - 1] : 0) >= ch) after = mid;
        else if (styles[mid * 2 + 1] < ch) before = mid + 1;
        else { type = styles[mid * 2 + 2]; break; }
      }
      var cut = type ? type.indexOf("cm-overlay ") : -1;
      return cut < 0 ? type : cut == 0 ? null : type.slice(0, cut - 1);
    },

    getModeAt: function(pos) {
      var mode = this.doc.mode;
      if (!mode.innerMode) return mode;
      return CodeMirror.innerMode(mode, this.getTokenAt(pos).state).mode;
    },

    getHelper: function(pos, type) {
      return this.getHelpers(pos, type)[0];
    },

    getHelpers: function(pos, type) {
      var found = [];
      if (!helpers.hasOwnProperty(type)) return helpers;
      var help = helpers[type], mode = this.getModeAt(pos);
      if (typeof mode[type] == "string") {
        if (help[mode[type]]) found.push(help[mode[type]]);
      } else if (mode[type]) {
        for (var i = 0; i < mode[type].length; i++) {
          var val = help[mode[type][i]];
          if (val) found.push(val);
        }
      } else if (mode.helperType && help[mode.helperType]) {
        found.push(help[mode.helperType]);
      } else if (help[mode.name]) {
        found.push(help[mode.name]);
      }
      for (var i = 0; i < help._global.length; i++) {
        var cur = help._global[i];
        if (cur.pred(mode, this) && indexOf(found, cur.val) == -1)
          found.push(cur.val);
      }
      return found;
    },

    getStateAfter: function(line, precise) {
      var doc = this.doc;
      line = clipLine(doc, line == null ? doc.first + doc.size - 1: line);
      return getStateBefore(this, line + 1, precise);
    },

    cursorCoords: function(start, mode) {
      var pos, range = this.doc.sel.primary();
      if (start == null) pos = range.head;
      else if (typeof start == "object") pos = clipPos(this.doc, start);
      else pos = start ? range.from() : range.to();
      return cursorCoords(this, pos, mode || "page");
    },

    charCoords: function(pos, mode) {
      return charCoords(this, clipPos(this.doc, pos), mode || "page");
    },

    coordsChar: function(coords, mode) {
      coords = fromCoordSystem(this, coords, mode || "page");
      return coordsChar(this, coords.left, coords.top);
    },

    lineAtHeight: function(height, mode) {
      height = fromCoordSystem(this, {top: height, left: 0}, mode || "page").top;
      return lineAtHeight(this.doc, height + this.display.viewOffset);
    },
    heightAtLine: function(line, mode) {
      var end = false, last = this.doc.first + this.doc.size - 1;
      if (line < this.doc.first) line = this.doc.first;
      else if (line > last) { line = last; end = true; }
      var lineObj = getLine(this.doc, line);
      return intoCoordSystem(this, lineObj, {top: 0, left: 0}, mode || "page").top +
        (end ? this.doc.height - heightAtLine(lineObj) : 0);
    },

    defaultTextHeight: function() { return textHeight(this.display); },
    defaultCharWidth: function() { return charWidth(this.display); },

    setGutterMarker: methodOp(function(line, gutterID, value) {
      return changeLine(this.doc, line, "gutter", function(line) {
        var markers = line.gutterMarkers || (line.gutterMarkers = {});
        markers[gutterID] = value;
        if (!value && isEmpty(markers)) line.gutterMarkers = null;
        return true;
      });
    }),

    clearGutter: methodOp(function(gutterID) {
      var cm = this, doc = cm.doc, i = doc.first;
      doc.iter(function(line) {
        if (line.gutterMarkers && line.gutterMarkers[gutterID]) {
          line.gutterMarkers[gutterID] = null;
          regLineChange(cm, i, "gutter");
          if (isEmpty(line.gutterMarkers)) line.gutterMarkers = null;
        }
        ++i;
      });
    }),

    addLineWidget: methodOp(function(handle, node, options) {
      return addLineWidget(this, handle, node, options);
    }),

    removeLineWidget: function(widget) { widget.clear(); },

    lineInfo: function(line) {
      if (typeof line == "number") {
        if (!isLine(this.doc, line)) return null;
        var n = line;
        line = getLine(this.doc, line);
        if (!line) return null;
      } else {
        var n = lineNo(line);
        if (n == null) return null;
      }
      return {line: n, handle: line, text: line.text, gutterMarkers: line.gutterMarkers,
              textClass: line.textClass, bgClass: line.bgClass, wrapClass: line.wrapClass,
              widgets: line.widgets};
    },

    getViewport: function() { return {from: this.display.viewFrom, to: this.display.viewTo};},

    addWidget: function(pos, node, scroll, vert, horiz) {
      var display = this.display;
      pos = cursorCoords(this, clipPos(this.doc, pos));
      var top = pos.bottom, left = pos.left;
      node.style.position = "absolute";
      display.sizer.appendChild(node);
      if (vert == "over") {
        top = pos.top;
      } else if (vert == "above" || vert == "near") {
        var vspace = Math.max(display.wrapper.clientHeight, this.doc.height),
        hspace = Math.max(display.sizer.clientWidth, display.lineSpace.clientWidth);
        // Default to positioning above (if specified and possible); otherwise default to positioning below
        if ((vert == 'above' || pos.bottom + node.offsetHeight > vspace) && pos.top > node.offsetHeight)
          top = pos.top - node.offsetHeight;
        else if (pos.bottom + node.offsetHeight <= vspace)
          top = pos.bottom;
        if (left + node.offsetWidth > hspace)
          left = hspace - node.offsetWidth;
      }
      node.style.top = top + "px";
      node.style.left = node.style.right = "";
      if (horiz == "right") {
        left = display.sizer.clientWidth - node.offsetWidth;
        node.style.right = "0px";
      } else {
        if (horiz == "left") left = 0;
        else if (horiz == "middle") left = (display.sizer.clientWidth - node.offsetWidth) / 2;
        node.style.left = left + "px";
      }
      if (scroll)
        scrollIntoView(this, left, top, left + node.offsetWidth, top + node.offsetHeight);
    },

    triggerOnKeyDown: methodOp(onKeyDown),
    triggerOnKeyPress: methodOp(onKeyPress),
    triggerOnKeyUp: methodOp(onKeyUp),

    execCommand: function(cmd) {
      if (commands.hasOwnProperty(cmd))
        return commands[cmd](this);
    },

    findPosH: function(from, amount, unit, visually) {
      var dir = 1;
      if (amount < 0) { dir = -1; amount = -amount; }
      for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
        cur = findPosH(this.doc, cur, dir, unit, visually);
        if (cur.hitSide) break;
      }
      return cur;
    },

    moveH: methodOp(function(dir, unit) {
      var cm = this;
      cm.extendSelectionsBy(function(range) {
        if (cm.display.shift || cm.doc.extend || range.empty())
          return findPosH(cm.doc, range.head, dir, unit, cm.options.rtlMoveVisually);
        else
          return dir < 0 ? range.from() : range.to();
      }, sel_move);
    }),

    deleteH: methodOp(function(dir, unit) {
      var sel = this.doc.sel, doc = this.doc;
      if (sel.somethingSelected())
        doc.replaceSelection("", null, "+delete");
      else
        deleteNearSelection(this, function(range) {
          var other = findPosH(doc, range.head, dir, unit, false);
          return dir < 0 ? {from: other, to: range.head} : {from: range.head, to: other};
        });
    }),

    findPosV: function(from, amount, unit, goalColumn) {
      var dir = 1, x = goalColumn;
      if (amount < 0) { dir = -1; amount = -amount; }
      for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
        var coords = cursorCoords(this, cur, "div");
        if (x == null) x = coords.left;
        else coords.left = x;
        cur = findPosV(this, coords, dir, unit);
        if (cur.hitSide) break;
      }
      return cur;
    },

    moveV: methodOp(function(dir, unit) {
      var cm = this, doc = this.doc, goals = [];
      var collapse = !cm.display.shift && !doc.extend && doc.sel.somethingSelected();
      doc.extendSelectionsBy(function(range) {
        if (collapse)
          return dir < 0 ? range.from() : range.to();
        var headPos = cursorCoords(cm, range.head, "div");
        if (range.goalColumn != null) headPos.left = range.goalColumn;
        goals.push(headPos.left);
        var pos = findPosV(cm, headPos, dir, unit);
        if (unit == "page" && range == doc.sel.primary())
          addToScrollPos(cm, null, charCoords(cm, pos, "div").top - headPos.top);
        return pos;
      }, sel_move);
      if (goals.length) for (var i = 0; i < doc.sel.ranges.length; i++)
        doc.sel.ranges[i].goalColumn = goals[i];
    }),

    toggleOverwrite: function(value) {
      if (value != null && value == this.state.overwrite) return;
      if (this.state.overwrite = !this.state.overwrite)
        addClass(this.display.cursorDiv, "CodeMirror-overwrite");
      else
        rmClass(this.display.cursorDiv, "CodeMirror-overwrite");

      signal(this, "overwriteToggle", this, this.state.overwrite);
    },
    hasFocus: function() { return activeElt() == this.display.input; },

    scrollTo: methodOp(function(x, y) {
      if (x != null || y != null) resolveScrollToPos(this);
      if (x != null) this.curOp.scrollLeft = x;
      if (y != null) this.curOp.scrollTop = y;
    }),
    getScrollInfo: function() {
      var scroller = this.display.scroller, co = scrollerCutOff;
      return {left: scroller.scrollLeft, top: scroller.scrollTop,
              height: scroller.scrollHeight - co, width: scroller.scrollWidth - co,
              clientHeight: scroller.clientHeight - co, clientWidth: scroller.clientWidth - co};
    },

    scrollIntoView: methodOp(function(range, margin) {
      if (range == null) {
        range = {from: this.doc.sel.primary().head, to: null};
        if (margin == null) margin = this.options.cursorScrollMargin;
      } else if (typeof range == "number") {
        range = {from: Pos(range, 0), to: null};
      } else if (range.from == null) {
        range = {from: range, to: null};
      }
      if (!range.to) range.to = range.from;
      range.margin = margin || 0;

      if (range.from.line != null) {
        resolveScrollToPos(this);
        this.curOp.scrollToPos = range;
      } else {
        var sPos = calculateScrollPos(this, Math.min(range.from.left, range.to.left),
                                      Math.min(range.from.top, range.to.top) - range.margin,
                                      Math.max(range.from.right, range.to.right),
                                      Math.max(range.from.bottom, range.to.bottom) + range.margin);
        this.scrollTo(sPos.scrollLeft, sPos.scrollTop);
      }
    }),

    setSize: methodOp(function(width, height) {
      var cm = this;
      function interpret(val) {
        return typeof val == "number" || /^\d+$/.test(String(val)) ? val + "px" : val;
      }
      if (width != null) cm.display.wrapper.style.width = interpret(width);
      if (height != null) cm.display.wrapper.style.height = interpret(height);
      if (cm.options.lineWrapping) clearLineMeasurementCache(this);
      var lineNo = cm.display.viewFrom;
      cm.doc.iter(lineNo, cm.display.viewTo, function(line) {
        if (line.widgets) for (var i = 0; i < line.widgets.length; i++)
          if (line.widgets[i].noHScroll) { regLineChange(cm, lineNo, "widget"); break; }
        ++lineNo;
      });
      cm.curOp.forceUpdate = true;
      signal(cm, "refresh", this);
    }),

    operation: function(f){return runInOp(this, f);},

    refresh: methodOp(function() {
      var oldHeight = this.display.cachedTextHeight;
      regChange(this);
      this.curOp.forceUpdate = true;
      clearCaches(this);
      this.scrollTo(this.doc.scrollLeft, this.doc.scrollTop);
      updateGutterSpace(this);
      if (oldHeight == null || Math.abs(oldHeight - textHeight(this.display)) > .5)
        estimateLineHeights(this);
      signal(this, "refresh", this);
    }),

    swapDoc: methodOp(function(doc) {
      var old = this.doc;
      old.cm = null;
      attachDoc(this, doc);
      clearCaches(this);
      resetInput(this);
      this.scrollTo(doc.scrollLeft, doc.scrollTop);
      signalLater(this, "swapDoc", this, old);
      return old;
    }),

    getInputField: function(){return this.display.input;},
    getWrapperElement: function(){return this.display.wrapper;},
    getScrollerElement: function(){return this.display.scroller;},
    getGutterElement: function(){return this.display.gutters;}
  };
  eventMixin(CodeMirror);

  // OPTION DEFAULTS

  // The default configuration options.
  var defaults = CodeMirror.defaults = {};
  // Functions to run when options are changed.
  var optionHandlers = CodeMirror.optionHandlers = {};

  function option(name, deflt, handle, notOnInit) {
    CodeMirror.defaults[name] = deflt;
    if (handle) optionHandlers[name] =
      notOnInit ? function(cm, val, old) {if (old != Init) handle(cm, val, old);} : handle;
  }

  // Passed to option handlers when there is no old value.
  var Init = CodeMirror.Init = {toString: function(){return "CodeMirror.Init";}};

  // These two are, on init, called from the constructor because they
  // have to be initialized before the editor can start at all.
  option("value", "", function(cm, val) {
    cm.setValue(val);
  }, true);
  option("mode", null, function(cm, val) {
    cm.doc.modeOption = val;
    loadMode(cm);
  }, true);

  option("indentUnit", 2, loadMode, true);
  option("indentWithTabs", false);
  option("smartIndent", true);
  option("tabSize", 4, function(cm) {
    resetModeState(cm);
    clearCaches(cm);
    regChange(cm);
  }, true);
  option("specialChars", /[\t\u0000-\u0019\u00ad\u200b\u2028\u2029\ufeff]/g, function(cm, val) {
    cm.options.specialChars = new RegExp(val.source + (val.test("\t") ? "" : "|\t"), "g");
    cm.refresh();
  }, true);
  option("specialCharPlaceholder", defaultSpecialCharPlaceholder, function(cm) {cm.refresh();}, true);
  option("electricChars", true);
  option("rtlMoveVisually", !windows);
  option("wholeLineUpdateBefore", true);

  option("theme", "default", function(cm) {
    themeChanged(cm);
    guttersChanged(cm);
  }, true);
  option("keyMap", "default", keyMapChanged);
  option("extraKeys", null);

  option("lineWrapping", false, wrappingChanged, true);
  option("gutters", [], function(cm) {
    setGuttersForLineNumbers(cm.options);
    guttersChanged(cm);
  }, true);
  option("fixedGutter", true, function(cm, val) {
    cm.display.gutters.style.left = val ? compensateForHScroll(cm.display) + "px" : "0";
    cm.refresh();
  }, true);
  option("coverGutterNextToScrollbar", false, updateScrollbars, true);
  option("lineNumbers", false, function(cm) {
    setGuttersForLineNumbers(cm.options);
    guttersChanged(cm);
  }, true);
  option("firstLineNumber", 1, guttersChanged, true);
  option("lineNumberFormatter", function(integer) {return integer;}, guttersChanged, true);
  option("showCursorWhenSelecting", false, updateSelection, true);

  option("resetSelectionOnContextMenu", true);

  option("readOnly", false, function(cm, val) {
    if (val == "nocursor") {
      onBlur(cm);
      cm.display.input.blur();
      cm.display.disabled = true;
    } else {
      cm.display.disabled = false;
      if (!val) resetInput(cm);
    }
  });
  option("disableInput", false, function(cm, val) {if (!val) resetInput(cm);}, true);
  option("dragDrop", true);

  option("cursorBlinkRate", 530);
  option("cursorScrollMargin", 0);
  option("cursorHeight", 1, updateSelection, true);
  option("singleCursorHeightPerLine", true, updateSelection, true);
  option("workTime", 100);
  option("workDelay", 100);
  option("flattenSpans", true, resetModeState, true);
  option("addModeClass", false, resetModeState, true);
  option("pollInterval", 100);
  option("undoDepth", 200, function(cm, val){cm.doc.history.undoDepth = val;});
  option("historyEventDelay", 1250);
  option("viewportMargin", 10, function(cm){cm.refresh();}, true);
  option("maxHighlightLength", 10000, resetModeState, true);
  option("moveInputWithCursor", true, function(cm, val) {
    if (!val) cm.display.inputDiv.style.top = cm.display.inputDiv.style.left = 0;
  });

  option("tabindex", null, function(cm, val) {
    cm.display.input.tabIndex = val || "";
  });
  option("autofocus", null);

  // MODE DEFINITION AND QUERYING

  // Known modes, by name and by MIME
  var modes = CodeMirror.modes = {}, mimeModes = CodeMirror.mimeModes = {};

  // Extra arguments are stored as the mode's dependencies, which is
  // used by (legacy) mechanisms like loadmode.js to automatically
  // load a mode. (Preferred mechanism is the require/define calls.)
  CodeMirror.defineMode = function(name, mode) {
    if (!CodeMirror.defaults.mode && name != "null") CodeMirror.defaults.mode = name;
    if (arguments.length > 2) {
      mode.dependencies = [];
      for (var i = 2; i < arguments.length; ++i) mode.dependencies.push(arguments[i]);
    }
    modes[name] = mode;
  };

  CodeMirror.defineMIME = function(mime, spec) {
    mimeModes[mime] = spec;
  };

  // Given a MIME type, a {name, ...options} config object, or a name
  // string, return a mode config object.
  CodeMirror.resolveMode = function(spec) {
    if (typeof spec == "string" && mimeModes.hasOwnProperty(spec)) {
      spec = mimeModes[spec];
    } else if (spec && typeof spec.name == "string" && mimeModes.hasOwnProperty(spec.name)) {
      var found = mimeModes[spec.name];
      if (typeof found == "string") found = {name: found};
      spec = createObj(found, spec);
      spec.name = found.name;
    } else if (typeof spec == "string" && /^[\w\-]+\/[\w\-]+\+xml$/.test(spec)) {
      return CodeMirror.resolveMode("application/xml");
    }
    if (typeof spec == "string") return {name: spec};
    else return spec || {name: "null"};
  };

  // Given a mode spec (anything that resolveMode accepts), find and
  // initialize an actual mode object.
  CodeMirror.getMode = function(options, spec) {
    var spec = CodeMirror.resolveMode(spec);
    var mfactory = modes[spec.name];
    if (!mfactory) return CodeMirror.getMode(options, "text/plain");
    var modeObj = mfactory(options, spec);
    if (modeExtensions.hasOwnProperty(spec.name)) {
      var exts = modeExtensions[spec.name];
      for (var prop in exts) {
        if (!exts.hasOwnProperty(prop)) continue;
        if (modeObj.hasOwnProperty(prop)) modeObj["_" + prop] = modeObj[prop];
        modeObj[prop] = exts[prop];
      }
    }
    modeObj.name = spec.name;
    if (spec.helperType) modeObj.helperType = spec.helperType;
    if (spec.modeProps) for (var prop in spec.modeProps)
      modeObj[prop] = spec.modeProps[prop];

    return modeObj;
  };

  // Minimal default mode.
  CodeMirror.defineMode("null", function() {
    return {token: function(stream) {stream.skipToEnd();}};
  });
  CodeMirror.defineMIME("text/plain", "null");

  // This can be used to attach properties to mode objects from
  // outside the actual mode definition.
  var modeExtensions = CodeMirror.modeExtensions = {};
  CodeMirror.extendMode = function(mode, properties) {
    var exts = modeExtensions.hasOwnProperty(mode) ? modeExtensions[mode] : (modeExtensions[mode] = {});
    copyObj(properties, exts);
  };

  // EXTENSIONS

  CodeMirror.defineExtension = function(name, func) {
    CodeMirror.prototype[name] = func;
  };
  CodeMirror.defineDocExtension = function(name, func) {
    Doc.prototype[name] = func;
  };
  CodeMirror.defineOption = option;

  var initHooks = [];
  CodeMirror.defineInitHook = function(f) {initHooks.push(f);};

  var helpers = CodeMirror.helpers = {};
  CodeMirror.registerHelper = function(type, name, value) {
    if (!helpers.hasOwnProperty(type)) helpers[type] = CodeMirror[type] = {_global: []};
    helpers[type][name] = value;
  };
  CodeMirror.registerGlobalHelper = function(type, name, predicate, value) {
    CodeMirror.registerHelper(type, name, value);
    helpers[type]._global.push({pred: predicate, val: value});
  };

  // MODE STATE HANDLING

  // Utility functions for working with state. Exported because nested
  // modes need to do this for their inner modes.

  var copyState = CodeMirror.copyState = function(mode, state) {
    if (state === true) return state;
    if (mode.copyState) return mode.copyState(state);
    var nstate = {};
    for (var n in state) {
      var val = state[n];
      if (val instanceof Array) val = val.concat([]);
      nstate[n] = val;
    }
    return nstate;
  };

  var startState = CodeMirror.startState = function(mode, a1, a2) {
    return mode.startState ? mode.startState(a1, a2) : true;
  };

  // Given a mode and a state (for that mode), find the inner mode and
  // state at the position that the state refers to.
  CodeMirror.innerMode = function(mode, state) {
    while (mode.innerMode) {
      var info = mode.innerMode(state);
      if (!info || info.mode == mode) break;
      state = info.state;
      mode = info.mode;
    }
    return info || {mode: mode, state: state};
  };

  // STANDARD COMMANDS

  // Commands are parameter-less actions that can be performed on an
  // editor, mostly used for keybindings.
  var commands = CodeMirror.commands = {
    selectAll: function(cm) {cm.setSelection(Pos(cm.firstLine(), 0), Pos(cm.lastLine()), sel_dontScroll);},
    singleSelection: function(cm) {
      cm.setSelection(cm.getCursor("anchor"), cm.getCursor("head"), sel_dontScroll);
    },
    killLine: function(cm) {
      deleteNearSelection(cm, function(range) {
        if (range.empty()) {
          var len = getLine(cm.doc, range.head.line).text.length;
          if (range.head.ch == len && range.head.line < cm.lastLine())
            return {from: range.head, to: Pos(range.head.line + 1, 0)};
          else
            return {from: range.head, to: Pos(range.head.line, len)};
        } else {
          return {from: range.from(), to: range.to()};
        }
      });
    },
    deleteLine: function(cm) {
      deleteNearSelection(cm, function(range) {
        return {from: Pos(range.from().line, 0),
                to: clipPos(cm.doc, Pos(range.to().line + 1, 0))};
      });
    },
    delLineLeft: function(cm) {
      deleteNearSelection(cm, function(range) {
        return {from: Pos(range.from().line, 0), to: range.from()};
      });
    },
    undo: function(cm) {cm.undo();},
    redo: function(cm) {cm.redo();},
    undoSelection: function(cm) {cm.undoSelection();},
    redoSelection: function(cm) {cm.redoSelection();},
    goDocStart: function(cm) {cm.extendSelection(Pos(cm.firstLine(), 0));},
    goDocEnd: function(cm) {cm.extendSelection(Pos(cm.lastLine()));},
    goLineStart: function(cm) {
      cm.extendSelectionsBy(function(range) { return lineStart(cm, range.head.line); },
                            {origin: "+move", bias: 1});
    },
    goLineStartSmart: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var start = lineStart(cm, range.head.line);
        var line = cm.getLineHandle(start.line);
        var order = getOrder(line);
        if (!order || order[0].level == 0) {
          var firstNonWS = Math.max(0, line.text.search(/\S/));
          var inWS = range.head.line == start.line && range.head.ch <= firstNonWS && range.head.ch;
          return Pos(start.line, inWS ? 0 : firstNonWS);
        }
        return start;
      }, {origin: "+move", bias: 1});
    },
    goLineEnd: function(cm) {
      cm.extendSelectionsBy(function(range) { return lineEnd(cm, range.head.line); },
                            {origin: "+move", bias: -1});
    },
    goLineRight: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
      }, sel_move);
    },
    goLineLeft: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: 0, top: top}, "div");
      }, sel_move);
    },
    goLineUp: function(cm) {cm.moveV(-1, "line");},
    goLineDown: function(cm) {cm.moveV(1, "line");},
    goPageUp: function(cm) {cm.moveV(-1, "page");},
    goPageDown: function(cm) {cm.moveV(1, "page");},
    goCharLeft: function(cm) {cm.moveH(-1, "char");},
    goCharRight: function(cm) {cm.moveH(1, "char");},
    goColumnLeft: function(cm) {cm.moveH(-1, "column");},
    goColumnRight: function(cm) {cm.moveH(1, "column");},
    goWordLeft: function(cm) {cm.moveH(-1, "word");},
    goGroupRight: function(cm) {cm.moveH(1, "group");},
    goGroupLeft: function(cm) {cm.moveH(-1, "group");},
    goWordRight: function(cm) {cm.moveH(1, "word");},
    delCharBefore: function(cm) {cm.deleteH(-1, "char");},
    delCharAfter: function(cm) {cm.deleteH(1, "char");},
    delWordBefore: function(cm) {cm.deleteH(-1, "word");},
    delWordAfter: function(cm) {cm.deleteH(1, "word");},
    delGroupBefore: function(cm) {cm.deleteH(-1, "group");},
    delGroupAfter: function(cm) {cm.deleteH(1, "group");},
    indentAuto: function(cm) {cm.indentSelection("smart");},
    indentMore: function(cm) {cm.indentSelection("add");},
    indentLess: function(cm) {cm.indentSelection("subtract");},
    insertTab: function(cm) {cm.replaceSelection("\t");},
    insertSoftTab: function(cm) {
      var spaces = [], ranges = cm.listSelections(), tabSize = cm.options.tabSize;
      for (var i = 0; i < ranges.length; i++) {
        var pos = ranges[i].from();
        var col = countColumn(cm.getLine(pos.line), pos.ch, tabSize);
        spaces.push(new Array(tabSize - col % tabSize + 1).join(" "));
      }
      cm.replaceSelections(spaces);
    },
    defaultTab: function(cm) {
      if (cm.somethingSelected()) cm.indentSelection("add");
      else cm.execCommand("insertTab");
    },
    transposeChars: function(cm) {
      runInOp(cm, function() {
        var ranges = cm.listSelections(), newSel = [];
        for (var i = 0; i < ranges.length; i++) {
          var cur = ranges[i].head, line = getLine(cm.doc, cur.line).text;
          if (line) {
            if (cur.ch == line.length) cur = new Pos(cur.line, cur.ch - 1);
            if (cur.ch > 0) {
              cur = new Pos(cur.line, cur.ch + 1);
              cm.replaceRange(line.charAt(cur.ch - 1) + line.charAt(cur.ch - 2),
                              Pos(cur.line, cur.ch - 2), cur, "+transpose");
            } else if (cur.line > cm.doc.first) {
              var prev = getLine(cm.doc, cur.line - 1).text;
              if (prev)
                cm.replaceRange(line.charAt(0) + "\n" + prev.charAt(prev.length - 1),
                                Pos(cur.line - 1, prev.length - 1), Pos(cur.line, 1), "+transpose");
            }
          }
          newSel.push(new Range(cur, cur));
        }
        cm.setSelections(newSel);
      });
    },
    newlineAndIndent: function(cm) {
      runInOp(cm, function() {
        var len = cm.listSelections().length;
        for (var i = 0; i < len; i++) {
          var range = cm.listSelections()[i];
          cm.replaceRange("\n", range.anchor, range.head, "+input");
          cm.indentLine(range.from().line + 1, null, true);
          ensureCursorVisible(cm);
        }
      });
    },
    toggleOverwrite: function(cm) {cm.toggleOverwrite();}
  };

  // STANDARD KEYMAPS

  var keyMap = CodeMirror.keyMap = {};
  keyMap.basic = {
    "Left": "goCharLeft", "Right": "goCharRight", "Up": "goLineUp", "Down": "goLineDown",
    "End": "goLineEnd", "Home": "goLineStartSmart", "PageUp": "goPageUp", "PageDown": "goPageDown",
    "Delete": "delCharAfter", "Backspace": "delCharBefore", "Shift-Backspace": "delCharBefore",
    "Tab": "defaultTab", "Shift-Tab": "indentAuto",
    "Enter": "newlineAndIndent", "Insert": "toggleOverwrite",
    "Esc": "singleSelection"
  };
  // Note that the save and find-related commands aren't defined by
  // default. User code or addons can define them. Unknown commands
  // are simply ignored.
  keyMap.pcDefault = {
    "Ctrl-A": "selectAll", "Ctrl-D": "deleteLine", "Ctrl-Z": "undo", "Shift-Ctrl-Z": "redo", "Ctrl-Y": "redo",
    "Ctrl-Home": "goDocStart", "Ctrl-Up": "goDocStart", "Ctrl-End": "goDocEnd", "Ctrl-Down": "goDocEnd",
    "Ctrl-Left": "goGroupLeft", "Ctrl-Right": "goGroupRight", "Alt-Left": "goLineStart", "Alt-Right": "goLineEnd",
    "Ctrl-Backspace": "delGroupBefore", "Ctrl-Delete": "delGroupAfter", "Ctrl-S": "save", "Ctrl-F": "find",
    "Ctrl-G": "findNext", "Shift-Ctrl-G": "findPrev", "Shift-Ctrl-F": "replace", "Shift-Ctrl-R": "replaceAll",
    "Ctrl-[": "indentLess", "Ctrl-]": "indentMore",
    "Ctrl-U": "undoSelection", "Shift-Ctrl-U": "redoSelection", "Alt-U": "redoSelection",
    fallthrough: "basic"
  };
  keyMap.macDefault = {
    "Cmd-A": "selectAll", "Cmd-D": "deleteLine", "Cmd-Z": "undo", "Shift-Cmd-Z": "redo", "Cmd-Y": "redo",
    "Cmd-Up": "goDocStart", "Cmd-End": "goDocEnd", "Cmd-Down": "goDocEnd", "Alt-Left": "goGroupLeft",
    "Alt-Right": "goGroupRight", "Cmd-Left": "goLineStart", "Cmd-Right": "goLineEnd", "Alt-Backspace": "delGroupBefore",
    "Ctrl-Alt-Backspace": "delGroupAfter", "Alt-Delete": "delGroupAfter", "Cmd-S": "save", "Cmd-F": "find",
    "Cmd-G": "findNext", "Shift-Cmd-G": "findPrev", "Cmd-Alt-F": "replace", "Shift-Cmd-Alt-F": "replaceAll",
    "Cmd-[": "indentLess", "Cmd-]": "indentMore", "Cmd-Backspace": "delLineLeft",
    "Cmd-U": "undoSelection", "Shift-Cmd-U": "redoSelection",
    fallthrough: ["basic", "emacsy"]
  };
  // Very basic readline/emacs-style bindings, which are standard on Mac.
  keyMap.emacsy = {
    "Ctrl-F": "goCharRight", "Ctrl-B": "goCharLeft", "Ctrl-P": "goLineUp", "Ctrl-N": "goLineDown",
    "Alt-F": "goWordRight", "Alt-B": "goWordLeft", "Ctrl-A": "goLineStart", "Ctrl-E": "goLineEnd",
    "Ctrl-V": "goPageDown", "Shift-Ctrl-V": "goPageUp", "Ctrl-D": "delCharAfter", "Ctrl-H": "delCharBefore",
    "Alt-D": "delWordAfter", "Alt-Backspace": "delWordBefore", "Ctrl-K": "killLine", "Ctrl-T": "transposeChars"
  };
  keyMap["default"] = mac ? keyMap.macDefault : keyMap.pcDefault;

  // KEYMAP DISPATCH

  function getKeyMap(val) {
    if (typeof val == "string") return keyMap[val];
    else return val;
  }

  // Given an array of keymaps and a key name, call handle on any
  // bindings found, until that returns a truthy value, at which point
  // we consider the key handled. Implements things like binding a key
  // to false stopping further handling and keymap fallthrough.
  var lookupKey = CodeMirror.lookupKey = function(name, maps, handle) {
    function lookup(map) {
      map = getKeyMap(map);
      var found = map[name];
      if (found === false) return "stop";
      if (found != null && handle(found)) return true;
      if (map.nofallthrough) return "stop";

      var fallthrough = map.fallthrough;
      if (fallthrough == null) return false;
      if (Object.prototype.toString.call(fallthrough) != "[object Array]")
        return lookup(fallthrough);
      for (var i = 0; i < fallthrough.length; ++i) {
        var done = lookup(fallthrough[i]);
        if (done) return done;
      }
      return false;
    }

    for (var i = 0; i < maps.length; ++i) {
      var done = lookup(maps[i]);
      if (done) return done != "stop";
    }
  };

  // Modifier key presses don't count as 'real' key presses for the
  // purpose of keymap fallthrough.
  var isModifierKey = CodeMirror.isModifierKey = function(event) {
    var name = keyNames[event.keyCode];
    return name == "Ctrl" || name == "Alt" || name == "Shift" || name == "Mod";
  };

  // Look up the name of a key as indicated by an event object.
  var keyName = CodeMirror.keyName = function(event, noShift) {
    if (presto && event.keyCode == 34 && event["char"]) return false;
    var name = keyNames[event.keyCode];
    if (name == null || event.altGraphKey) return false;
    if (event.altKey) name = "Alt-" + name;
    if (flipCtrlCmd ? event.metaKey : event.ctrlKey) name = "Ctrl-" + name;
    if (flipCtrlCmd ? event.ctrlKey : event.metaKey) name = "Cmd-" + name;
    if (!noShift && event.shiftKey) name = "Shift-" + name;
    return name;
  };

  // FROMTEXTAREA

  CodeMirror.fromTextArea = function(textarea, options) {
    if (!options) options = {};
    options.value = textarea.value;
    if (!options.tabindex && textarea.tabindex)
      options.tabindex = textarea.tabindex;
    if (!options.placeholder && textarea.placeholder)
      options.placeholder = textarea.placeholder;
    // Set autofocus to true if this textarea is focused, or if it has
    // autofocus and no other element is focused.
    if (options.autofocus == null) {
      var hasFocus = activeElt();
      options.autofocus = hasFocus == textarea ||
        textarea.getAttribute("autofocus") != null && hasFocus == document.body;
    }

    function save() {textarea.value = cm.getValue();}
    if (textarea.form) {
      on(textarea.form, "submit", save);
      // Deplorable hack to make the submit method do the right thing.
      if (!options.leaveSubmitMethodAlone) {
        var form = textarea.form, realSubmit = form.submit;
        try {
          var wrappedSubmit = form.submit = function() {
            save();
            form.submit = realSubmit;
            form.submit();
            form.submit = wrappedSubmit;
          };
        } catch(e) {}
      }
    }

    textarea.style.display = "none";
    var cm = CodeMirror(function(node) {
      textarea.parentNode.insertBefore(node, textarea.nextSibling);
    }, options);
    cm.save = save;
    cm.getTextArea = function() { return textarea; };
    cm.toTextArea = function() {
      save();
      textarea.parentNode.removeChild(cm.getWrapperElement());
      textarea.style.display = "";
      if (textarea.form) {
        off(textarea.form, "submit", save);
        if (typeof textarea.form.submit == "function")
          textarea.form.submit = realSubmit;
      }
    };
    return cm;
  };

  // STRING STREAM

  // Fed to the mode parsers, provides helper functions to make
  // parsers more succinct.

  var StringStream = CodeMirror.StringStream = function(string, tabSize) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
    this.lastColumnPos = this.lastColumnValue = 0;
    this.lineStart = 0;
  };

  StringStream.prototype = {
    eol: function() {return this.pos >= this.string.length;},
    sol: function() {return this.pos == this.lineStart;},
    peek: function() {return this.string.charAt(this.pos) || undefined;},
    next: function() {
      if (this.pos < this.string.length)
        return this.string.charAt(this.pos++);
    },
    eat: function(match) {
      var ch = this.string.charAt(this.pos);
      if (typeof match == "string") var ok = ch == match;
      else var ok = ch && (match.test ? match.test(ch) : match(ch));
      if (ok) {++this.pos; return ch;}
    },
    eatWhile: function(match) {
      var start = this.pos;
      while (this.eat(match)){}
      return this.pos > start;
    },
    eatSpace: function() {
      var start = this.pos;
      while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) ++this.pos;
      return this.pos > start;
    },
    skipToEnd: function() {this.pos = this.string.length;},
    skipTo: function(ch) {
      var found = this.string.indexOf(ch, this.pos);
      if (found > -1) {this.pos = found; return true;}
    },
    backUp: function(n) {this.pos -= n;},
    column: function() {
      if (this.lastColumnPos < this.start) {
        this.lastColumnValue = countColumn(this.string, this.start, this.tabSize, this.lastColumnPos, this.lastColumnValue);
        this.lastColumnPos = this.start;
      }
      return this.lastColumnValue - (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
    },
    indentation: function() {
      return countColumn(this.string, null, this.tabSize) -
        (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
    },
    match: function(pattern, consume, caseInsensitive) {
      if (typeof pattern == "string") {
        var cased = function(str) {return caseInsensitive ? str.toLowerCase() : str;};
        var substr = this.string.substr(this.pos, pattern.length);
        if (cased(substr) == cased(pattern)) {
          if (consume !== false) this.pos += pattern.length;
          return true;
        }
      } else {
        var match = this.string.slice(this.pos).match(pattern);
        if (match && match.index > 0) return null;
        if (match && consume !== false) this.pos += match[0].length;
        return match;
      }
    },
    current: function(){return this.string.slice(this.start, this.pos);},
    hideFirstChars: function(n, inner) {
      this.lineStart += n;
      try { return inner(); }
      finally { this.lineStart -= n; }
    }
  };

  // TEXTMARKERS

  // Created with markText and setBookmark methods. A TextMarker is a
  // handle that can be used to clear or find a marked position in the
  // document. Line objects hold arrays (markedSpans) containing
  // {from, to, marker} object pointing to such marker objects, and
  // indicating that such a marker is present on that line. Multiple
  // lines may point to the same marker when it spans across lines.
  // The spans will have null for their from/to properties when the
  // marker continues beyond the start/end of the line. Markers have
  // links back to the lines they currently touch.

  var TextMarker = CodeMirror.TextMarker = function(doc, type) {
    this.lines = [];
    this.type = type;
    this.doc = doc;
  };
  eventMixin(TextMarker);

  // Clear the marker.
  TextMarker.prototype.clear = function() {
    if (this.explicitlyCleared) return;
    var cm = this.doc.cm, withOp = cm && !cm.curOp;
    if (withOp) startOperation(cm);
    if (hasHandler(this, "clear")) {
      var found = this.find();
      if (found) signalLater(this, "clear", found.from, found.to);
    }
    var min = null, max = null;
    for (var i = 0; i < this.lines.length; ++i) {
      var line = this.lines[i];
      var span = getMarkedSpanFor(line.markedSpans, this);
      if (cm && !this.collapsed) regLineChange(cm, lineNo(line), "text");
      else if (cm) {
        if (span.to != null) max = lineNo(line);
        if (span.from != null) min = lineNo(line);
      }
      line.markedSpans = removeMarkedSpan(line.markedSpans, span);
      if (span.from == null && this.collapsed && !lineIsHidden(this.doc, line) && cm)
        updateLineHeight(line, textHeight(cm.display));
    }
    if (cm && this.collapsed && !cm.options.lineWrapping) for (var i = 0; i < this.lines.length; ++i) {
      var visual = visualLine(this.lines[i]), len = lineLength(visual);
      if (len > cm.display.maxLineLength) {
        cm.display.maxLine = visual;
        cm.display.maxLineLength = len;
        cm.display.maxLineChanged = true;
      }
    }

    if (min != null && cm && this.collapsed) regChange(cm, min, max + 1);
    this.lines.length = 0;
    this.explicitlyCleared = true;
    if (this.atomic && this.doc.cantEdit) {
      this.doc.cantEdit = false;
      if (cm) reCheckSelection(cm.doc);
    }
    if (cm) signalLater(cm, "markerCleared", cm, this);
    if (withOp) endOperation(cm);
    if (this.parent) this.parent.clear();
  };

  // Find the position of the marker in the document. Returns a {from,
  // to} object by default. Side can be passed to get a specific side
  // -- 0 (both), -1 (left), or 1 (right). When lineObj is true, the
  // Pos objects returned contain a line object, rather than a line
  // number (used to prevent looking up the same line twice).
  TextMarker.prototype.find = function(side, lineObj) {
    if (side == null && this.type == "bookmark") side = 1;
    var from, to;
    for (var i = 0; i < this.lines.length; ++i) {
      var line = this.lines[i];
      var span = getMarkedSpanFor(line.markedSpans, this);
      if (span.from != null) {
        from = Pos(lineObj ? line : lineNo(line), span.from);
        if (side == -1) return from;
      }
      if (span.to != null) {
        to = Pos(lineObj ? line : lineNo(line), span.to);
        if (side == 1) return to;
      }
    }
    return from && {from: from, to: to};
  };

  // Signals that the marker's widget changed, and surrounding layout
  // should be recomputed.
  TextMarker.prototype.changed = function() {
    var pos = this.find(-1, true), widget = this, cm = this.doc.cm;
    if (!pos || !cm) return;
    runInOp(cm, function() {
      var line = pos.line, lineN = lineNo(pos.line);
      var view = findViewForLine(cm, lineN);
      if (view) {
        clearLineMeasurementCacheFor(view);
        cm.curOp.selectionChanged = cm.curOp.forceUpdate = true;
      }
      cm.curOp.updateMaxLine = true;
      if (!lineIsHidden(widget.doc, line) && widget.height != null) {
        var oldHeight = widget.height;
        widget.height = null;
        var dHeight = widgetHeight(widget) - oldHeight;
        if (dHeight)
          updateLineHeight(line, line.height + dHeight);
      }
    });
  };

  TextMarker.prototype.attachLine = function(line) {
    if (!this.lines.length && this.doc.cm) {
      var op = this.doc.cm.curOp;
      if (!op.maybeHiddenMarkers || indexOf(op.maybeHiddenMarkers, this) == -1)
        (op.maybeUnhiddenMarkers || (op.maybeUnhiddenMarkers = [])).push(this);
    }
    this.lines.push(line);
  };
  TextMarker.prototype.detachLine = function(line) {
    this.lines.splice(indexOf(this.lines, line), 1);
    if (!this.lines.length && this.doc.cm) {
      var op = this.doc.cm.curOp;
      (op.maybeHiddenMarkers || (op.maybeHiddenMarkers = [])).push(this);
    }
  };

  // Collapsed markers have unique ids, in order to be able to order
  // them, which is needed for uniquely determining an outer marker
  // when they overlap (they may nest, but not partially overlap).
  var nextMarkerId = 0;

  // Create a marker, wire it up to the right lines, and
  function markText(doc, from, to, options, type) {
    // Shared markers (across linked documents) are handled separately
    // (markTextShared will call out to this again, once per
    // document).
    if (options && options.shared) return markTextShared(doc, from, to, options, type);
    // Ensure we are in an operation.
    if (doc.cm && !doc.cm.curOp) return operation(doc.cm, markText)(doc, from, to, options, type);

    var marker = new TextMarker(doc, type), diff = cmp(from, to);
    if (options) copyObj(options, marker, false);
    // Don't connect empty markers unless clearWhenEmpty is false
    if (diff > 0 || diff == 0 && marker.clearWhenEmpty !== false)
      return marker;
    if (marker.replacedWith) {
      // Showing up as a widget implies collapsed (widget replaces text)
      marker.collapsed = true;
      marker.widgetNode = elt("span", [marker.replacedWith], "CodeMirror-widget");
      if (!options.handleMouseEvents) marker.widgetNode.ignoreEvents = true;
      if (options.insertLeft) marker.widgetNode.insertLeft = true;
    }
    if (marker.collapsed) {
      if (conflictingCollapsedRange(doc, from.line, from, to, marker) ||
          from.line != to.line && conflictingCollapsedRange(doc, to.line, from, to, marker))
        throw new Error("Inserting collapsed marker partially overlapping an existing one");
      sawCollapsedSpans = true;
    }

    if (marker.addToHistory)
      addChangeToHistory(doc, {from: from, to: to, origin: "markText"}, doc.sel, NaN);

    var curLine = from.line, cm = doc.cm, updateMaxLine;
    doc.iter(curLine, to.line + 1, function(line) {
      if (cm && marker.collapsed && !cm.options.lineWrapping && visualLine(line) == cm.display.maxLine)
        updateMaxLine = true;
      if (marker.collapsed && curLine != from.line) updateLineHeight(line, 0);
      addMarkedSpan(line, new MarkedSpan(marker,
                                         curLine == from.line ? from.ch : null,
                                         curLine == to.line ? to.ch : null));
      ++curLine;
    });
    // lineIsHidden depends on the presence of the spans, so needs a second pass
    if (marker.collapsed) doc.iter(from.line, to.line + 1, function(line) {
      if (lineIsHidden(doc, line)) updateLineHeight(line, 0);
    });

    if (marker.clearOnEnter) on(marker, "beforeCursorEnter", function() { marker.clear(); });

    if (marker.readOnly) {
      sawReadOnlySpans = true;
      if (doc.history.done.length || doc.history.undone.length)
        doc.clearHistory();
    }
    if (marker.collapsed) {
      marker.id = ++nextMarkerId;
      marker.atomic = true;
    }
    if (cm) {
      // Sync editor state
      if (updateMaxLine) cm.curOp.updateMaxLine = true;
      if (marker.collapsed)
        regChange(cm, from.line, to.line + 1);
      else if (marker.className || marker.title || marker.startStyle || marker.endStyle)
        for (var i = from.line; i <= to.line; i++) regLineChange(cm, i, "text");
      if (marker.atomic) reCheckSelection(cm.doc);
      signalLater(cm, "markerAdded", cm, marker);
    }
    return marker;
  }

  // SHARED TEXTMARKERS

  // A shared marker spans multiple linked documents. It is
  // implemented as a meta-marker-object controlling multiple normal
  // markers.
  var SharedTextMarker = CodeMirror.SharedTextMarker = function(markers, primary) {
    this.markers = markers;
    this.primary = primary;
    for (var i = 0; i < markers.length; ++i)
      markers[i].parent = this;
  };
  eventMixin(SharedTextMarker);

  SharedTextMarker.prototype.clear = function() {
    if (this.explicitlyCleared) return;
    this.explicitlyCleared = true;
    for (var i = 0; i < this.markers.length; ++i)
      this.markers[i].clear();
    signalLater(this, "clear");
  };
  SharedTextMarker.prototype.find = function(side, lineObj) {
    return this.primary.find(side, lineObj);
  };

  function markTextShared(doc, from, to, options, type) {
    options = copyObj(options);
    options.shared = false;
    var markers = [markText(doc, from, to, options, type)], primary = markers[0];
    var widget = options.widgetNode;
    linkedDocs(doc, function(doc) {
      if (widget) options.widgetNode = widget.cloneNode(true);
      markers.push(markText(doc, clipPos(doc, from), clipPos(doc, to), options, type));
      for (var i = 0; i < doc.linked.length; ++i)
        if (doc.linked[i].isParent) return;
      primary = lst(markers);
    });
    return new SharedTextMarker(markers, primary);
  }

  function findSharedMarkers(doc) {
    return doc.findMarks(Pos(doc.first, 0), doc.clipPos(Pos(doc.lastLine())),
                         function(m) { return m.parent; });
  }

  function copySharedMarkers(doc, markers) {
    for (var i = 0; i < markers.length; i++) {
      var marker = markers[i], pos = marker.find();
      var mFrom = doc.clipPos(pos.from), mTo = doc.clipPos(pos.to);
      if (cmp(mFrom, mTo)) {
        var subMark = markText(doc, mFrom, mTo, marker.primary, marker.primary.type);
        marker.markers.push(subMark);
        subMark.parent = marker;
      }
    }
  }

  function detachSharedMarkers(markers) {
    for (var i = 0; i < markers.length; i++) {
      var marker = markers[i], linked = [marker.primary.doc];;
      linkedDocs(marker.primary.doc, function(d) { linked.push(d); });
      for (var j = 0; j < marker.markers.length; j++) {
        var subMarker = marker.markers[j];
        if (indexOf(linked, subMarker.doc) == -1) {
          subMarker.parent = null;
          marker.markers.splice(j--, 1);
        }
      }
    }
  }

  // TEXTMARKER SPANS

  function MarkedSpan(marker, from, to) {
    this.marker = marker;
    this.from = from; this.to = to;
  }

  // Search an array of spans for a span matching the given marker.
  function getMarkedSpanFor(spans, marker) {
    if (spans) for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.marker == marker) return span;
    }
  }
  // Remove a span from an array, returning undefined if no spans are
  // left (we don't store arrays for lines without spans).
  function removeMarkedSpan(spans, span) {
    for (var r, i = 0; i < spans.length; ++i)
      if (spans[i] != span) (r || (r = [])).push(spans[i]);
    return r;
  }
  // Add a span to a line.
  function addMarkedSpan(line, span) {
    line.markedSpans = line.markedSpans ? line.markedSpans.concat([span]) : [span];
    span.marker.attachLine(line);
  }

  // Used for the algorithm that adjusts markers for a change in the
  // document. These functions cut an array of spans at a given
  // character position, returning an array of remaining chunks (or
  // undefined if nothing remains).
  function markedSpansBefore(old, startCh, isInsert) {
    if (old) for (var i = 0, nw; i < old.length; ++i) {
      var span = old[i], marker = span.marker;
      var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= startCh : span.from < startCh);
      if (startsBefore || span.from == startCh && marker.type == "bookmark" && (!isInsert || !span.marker.insertLeft)) {
        var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= startCh : span.to > startCh);
        (nw || (nw = [])).push(new MarkedSpan(marker, span.from, endsAfter ? null : span.to));
      }
    }
    return nw;
  }
  function markedSpansAfter(old, endCh, isInsert) {
    if (old) for (var i = 0, nw; i < old.length; ++i) {
      var span = old[i], marker = span.marker;
      var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= endCh : span.to > endCh);
      if (endsAfter || span.from == endCh && marker.type == "bookmark" && (!isInsert || span.marker.insertLeft)) {
        var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= endCh : span.from < endCh);
        (nw || (nw = [])).push(new MarkedSpan(marker, startsBefore ? null : span.from - endCh,
                                              span.to == null ? null : span.to - endCh));
      }
    }
    return nw;
  }

  // Given a change object, compute the new set of marker spans that
  // cover the line in which the change took place. Removes spans
  // entirely within the change, reconnects spans belonging to the
  // same marker that appear on both sides of the change, and cuts off
  // spans partially within the change. Returns an array of span
  // arrays with one element for each line in (after) the change.
  function stretchSpansOverChange(doc, change) {
    var oldFirst = isLine(doc, change.from.line) && getLine(doc, change.from.line).markedSpans;
    var oldLast = isLine(doc, change.to.line) && getLine(doc, change.to.line).markedSpans;
    if (!oldFirst && !oldLast) return null;

    var startCh = change.from.ch, endCh = change.to.ch, isInsert = cmp(change.from, change.to) == 0;
    // Get the spans that 'stick out' on both sides
    var first = markedSpansBefore(oldFirst, startCh, isInsert);
    var last = markedSpansAfter(oldLast, endCh, isInsert);

    // Next, merge those two ends
    var sameLine = change.text.length == 1, offset = lst(change.text).length + (sameLine ? startCh : 0);
    if (first) {
      // Fix up .to properties of first
      for (var i = 0; i < first.length; ++i) {
        var span = first[i];
        if (span.to == null) {
          var found = getMarkedSpanFor(last, span.marker);
          if (!found) span.to = startCh;
          else if (sameLine) span.to = found.to == null ? null : found.to + offset;
        }
      }
    }
    if (last) {
      // Fix up .from in last (or move them into first in case of sameLine)
      for (var i = 0; i < last.length; ++i) {
        var span = last[i];
        if (span.to != null) span.to += offset;
        if (span.from == null) {
          var found = getMarkedSpanFor(first, span.marker);
          if (!found) {
            span.from = offset;
            if (sameLine) (first || (first = [])).push(span);
          }
        } else {
          span.from += offset;
          if (sameLine) (first || (first = [])).push(span);
        }
      }
    }
    // Make sure we didn't create any zero-length spans
    if (first) first = clearEmptySpans(first);
    if (last && last != first) last = clearEmptySpans(last);

    var newMarkers = [first];
    if (!sameLine) {
      // Fill gap with whole-line-spans
      var gap = change.text.length - 2, gapMarkers;
      if (gap > 0 && first)
        for (var i = 0; i < first.length; ++i)
          if (first[i].to == null)
            (gapMarkers || (gapMarkers = [])).push(new MarkedSpan(first[i].marker, null, null));
      for (var i = 0; i < gap; ++i)
        newMarkers.push(gapMarkers);
      newMarkers.push(last);
    }
    return newMarkers;
  }

  // Remove spans that are empty and don't have a clearWhenEmpty
  // option of false.
  function clearEmptySpans(spans) {
    for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.from != null && span.from == span.to && span.marker.clearWhenEmpty !== false)
        spans.splice(i--, 1);
    }
    if (!spans.length) return null;
    return spans;
  }

  // Used for un/re-doing changes from the history. Combines the
  // result of computing the existing spans with the set of spans that
  // existed in the history (so that deleting around a span and then
  // undoing brings back the span).
  function mergeOldSpans(doc, change) {
    var old = getOldSpans(doc, change);
    var stretched = stretchSpansOverChange(doc, change);
    if (!old) return stretched;
    if (!stretched) return old;

    for (var i = 0; i < old.length; ++i) {
      var oldCur = old[i], stretchCur = stretched[i];
      if (oldCur && stretchCur) {
        spans: for (var j = 0; j < stretchCur.length; ++j) {
          var span = stretchCur[j];
          for (var k = 0; k < oldCur.length; ++k)
            if (oldCur[k].marker == span.marker) continue spans;
          oldCur.push(span);
        }
      } else if (stretchCur) {
        old[i] = stretchCur;
      }
    }
    return old;
  }

  // Used to 'clip' out readOnly ranges when making a change.
  function removeReadOnlyRanges(doc, from, to) {
    var markers = null;
    doc.iter(from.line, to.line + 1, function(line) {
      if (line.markedSpans) for (var i = 0; i < line.markedSpans.length; ++i) {
        var mark = line.markedSpans[i].marker;
        if (mark.readOnly && (!markers || indexOf(markers, mark) == -1))
          (markers || (markers = [])).push(mark);
      }
    });
    if (!markers) return null;
    var parts = [{from: from, to: to}];
    for (var i = 0; i < markers.length; ++i) {
      var mk = markers[i], m = mk.find(0);
      for (var j = 0; j < parts.length; ++j) {
        var p = parts[j];
        if (cmp(p.to, m.from) < 0 || cmp(p.from, m.to) > 0) continue;
        var newParts = [j, 1], dfrom = cmp(p.from, m.from), dto = cmp(p.to, m.to);
        if (dfrom < 0 || !mk.inclusiveLeft && !dfrom)
          newParts.push({from: p.from, to: m.from});
        if (dto > 0 || !mk.inclusiveRight && !dto)
          newParts.push({from: m.to, to: p.to});
        parts.splice.apply(parts, newParts);
        j += newParts.length - 1;
      }
    }
    return parts;
  }

  // Connect or disconnect spans from a line.
  function detachMarkedSpans(line) {
    var spans = line.markedSpans;
    if (!spans) return;
    for (var i = 0; i < spans.length; ++i)
      spans[i].marker.detachLine(line);
    line.markedSpans = null;
  }
  function attachMarkedSpans(line, spans) {
    if (!spans) return;
    for (var i = 0; i < spans.length; ++i)
      spans[i].marker.attachLine(line);
    line.markedSpans = spans;
  }

  // Helpers used when computing which overlapping collapsed span
  // counts as the larger one.
  function extraLeft(marker) { return marker.inclusiveLeft ? -1 : 0; }
  function extraRight(marker) { return marker.inclusiveRight ? 1 : 0; }

  // Returns a number indicating which of two overlapping collapsed
  // spans is larger (and thus includes the other). Falls back to
  // comparing ids when the spans cover exactly the same range.
  function compareCollapsedMarkers(a, b) {
    var lenDiff = a.lines.length - b.lines.length;
    if (lenDiff != 0) return lenDiff;
    var aPos = a.find(), bPos = b.find();
    var fromCmp = cmp(aPos.from, bPos.from) || extraLeft(a) - extraLeft(b);
    if (fromCmp) return -fromCmp;
    var toCmp = cmp(aPos.to, bPos.to) || extraRight(a) - extraRight(b);
    if (toCmp) return toCmp;
    return b.id - a.id;
  }

  // Find out whether a line ends or starts in a collapsed span. If
  // so, return the marker for that span.
  function collapsedSpanAtSide(line, start) {
    var sps = sawCollapsedSpans && line.markedSpans, found;
    if (sps) for (var sp, i = 0; i < sps.length; ++i) {
      sp = sps[i];
      if (sp.marker.collapsed && (start ? sp.from : sp.to) == null &&
          (!found || compareCollapsedMarkers(found, sp.marker) < 0))
        found = sp.marker;
    }
    return found;
  }
  function collapsedSpanAtStart(line) { return collapsedSpanAtSide(line, true); }
  function collapsedSpanAtEnd(line) { return collapsedSpanAtSide(line, false); }

  // Test whether there exists a collapsed span that partially
  // overlaps (covers the start or end, but not both) of a new span.
  // Such overlap is not allowed.
  function conflictingCollapsedRange(doc, lineNo, from, to, marker) {
    var line = getLine(doc, lineNo);
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var i = 0; i < sps.length; ++i) {
      var sp = sps[i];
      if (!sp.marker.collapsed) continue;
      var found = sp.marker.find(0);
      var fromCmp = cmp(found.from, from) || extraLeft(sp.marker) - extraLeft(marker);
      var toCmp = cmp(found.to, to) || extraRight(sp.marker) - extraRight(marker);
      if (fromCmp >= 0 && toCmp <= 0 || fromCmp <= 0 && toCmp >= 0) continue;
      if (fromCmp <= 0 && (cmp(found.to, from) > 0 || (sp.marker.inclusiveRight && marker.inclusiveLeft)) ||
          fromCmp >= 0 && (cmp(found.from, to) < 0 || (sp.marker.inclusiveLeft && marker.inclusiveRight)))
        return true;
    }
  }

  // A visual line is a line as drawn on the screen. Folding, for
  // example, can cause multiple logical lines to appear on the same
  // visual line. This finds the start of the visual line that the
  // given line is part of (usually that is the line itself).
  function visualLine(line) {
    var merged;
    while (merged = collapsedSpanAtStart(line))
      line = merged.find(-1, true).line;
    return line;
  }

  // Returns an array of logical lines that continue the visual line
  // started by the argument, or undefined if there are no such lines.
  function visualLineContinued(line) {
    var merged, lines;
    while (merged = collapsedSpanAtEnd(line)) {
      line = merged.find(1, true).line;
      (lines || (lines = [])).push(line);
    }
    return lines;
  }

  // Get the line number of the start of the visual line that the
  // given line number is part of.
  function visualLineNo(doc, lineN) {
    var line = getLine(doc, lineN), vis = visualLine(line);
    if (line == vis) return lineN;
    return lineNo(vis);
  }
  // Get the line number of the start of the next visual line after
  // the given line.
  function visualLineEndNo(doc, lineN) {
    if (lineN > doc.lastLine()) return lineN;
    var line = getLine(doc, lineN), merged;
    if (!lineIsHidden(doc, line)) return lineN;
    while (merged = collapsedSpanAtEnd(line))
      line = merged.find(1, true).line;
    return lineNo(line) + 1;
  }

  // Compute whether a line is hidden. Lines count as hidden when they
  // are part of a visual line that starts with another line, or when
  // they are entirely covered by collapsed, non-widget span.
  function lineIsHidden(doc, line) {
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var sp, i = 0; i < sps.length; ++i) {
      sp = sps[i];
      if (!sp.marker.collapsed) continue;
      if (sp.from == null) return true;
      if (sp.marker.widgetNode) continue;
      if (sp.from == 0 && sp.marker.inclusiveLeft && lineIsHiddenInner(doc, line, sp))
        return true;
    }
  }
  function lineIsHiddenInner(doc, line, span) {
    if (span.to == null) {
      var end = span.marker.find(1, true);
      return lineIsHiddenInner(doc, end.line, getMarkedSpanFor(end.line.markedSpans, span.marker));
    }
    if (span.marker.inclusiveRight && span.to == line.text.length)
      return true;
    for (var sp, i = 0; i < line.markedSpans.length; ++i) {
      sp = line.markedSpans[i];
      if (sp.marker.collapsed && !sp.marker.widgetNode && sp.from == span.to &&
          (sp.to == null || sp.to != span.from) &&
          (sp.marker.inclusiveLeft || span.marker.inclusiveRight) &&
          lineIsHiddenInner(doc, line, sp)) return true;
    }
  }

  // LINE WIDGETS

  // Line widgets are block elements displayed above or below a line.

  var LineWidget = CodeMirror.LineWidget = function(cm, node, options) {
    if (options) for (var opt in options) if (options.hasOwnProperty(opt))
      this[opt] = options[opt];
    this.cm = cm;
    this.node = node;
  };
  eventMixin(LineWidget);

  function adjustScrollWhenAboveVisible(cm, line, diff) {
    if (heightAtLine(line) < ((cm.curOp && cm.curOp.scrollTop) || cm.doc.scrollTop))
      addToScrollPos(cm, null, diff);
  }

  LineWidget.prototype.clear = function() {
    var cm = this.cm, ws = this.line.widgets, line = this.line, no = lineNo(line);
    if (no == null || !ws) return;
    for (var i = 0; i < ws.length; ++i) if (ws[i] == this) ws.splice(i--, 1);
    if (!ws.length) line.widgets = null;
    var height = widgetHeight(this);
    runInOp(cm, function() {
      adjustScrollWhenAboveVisible(cm, line, -height);
      regLineChange(cm, no, "widget");
      updateLineHeight(line, Math.max(0, line.height - height));
    });
  };
  LineWidget.prototype.changed = function() {
    var oldH = this.height, cm = this.cm, line = this.line;
    this.height = null;
    var diff = widgetHeight(this) - oldH;
    if (!diff) return;
    runInOp(cm, function() {
      cm.curOp.forceUpdate = true;
      adjustScrollWhenAboveVisible(cm, line, diff);
      updateLineHeight(line, line.height + diff);
    });
  };

  function widgetHeight(widget) {
    if (widget.height != null) return widget.height;
    if (!contains(document.body, widget.node)) {
      var parentStyle = "position: relative;";
      if (widget.coverGutter)
        parentStyle += "margin-left: -" + widget.cm.getGutterElement().offsetWidth + "px;";
      removeChildrenAndAdd(widget.cm.display.measure, elt("div", [widget.node], null, parentStyle));
    }
    return widget.height = widget.node.offsetHeight;
  }

  function addLineWidget(cm, handle, node, options) {
    var widget = new LineWidget(cm, node, options);
    if (widget.noHScroll) cm.display.alignWidgets = true;
    changeLine(cm.doc, handle, "widget", function(line) {
      var widgets = line.widgets || (line.widgets = []);
      if (widget.insertAt == null) widgets.push(widget);
      else widgets.splice(Math.min(widgets.length - 1, Math.max(0, widget.insertAt)), 0, widget);
      widget.line = line;
      if (!lineIsHidden(cm.doc, line)) {
        var aboveVisible = heightAtLine(line) < cm.doc.scrollTop;
        updateLineHeight(line, line.height + widgetHeight(widget));
        if (aboveVisible) addToScrollPos(cm, null, widget.height);
        cm.curOp.forceUpdate = true;
      }
      return true;
    });
    return widget;
  }

  // LINE DATA STRUCTURE

  // Line objects. These hold state related to a line, including
  // highlighting info (the styles array).
  var Line = CodeMirror.Line = function(text, markedSpans, estimateHeight) {
    this.text = text;
    attachMarkedSpans(this, markedSpans);
    this.height = estimateHeight ? estimateHeight(this) : 1;
  };
  eventMixin(Line);
  Line.prototype.lineNo = function() { return lineNo(this); };

  // Change the content (text, markers) of a line. Automatically
  // invalidates cached information and tries to re-estimate the
  // line's height.
  function updateLine(line, text, markedSpans, estimateHeight) {
    line.text = text;
    if (line.stateAfter) line.stateAfter = null;
    if (line.styles) line.styles = null;
    if (line.order != null) line.order = null;
    detachMarkedSpans(line);
    attachMarkedSpans(line, markedSpans);
    var estHeight = estimateHeight ? estimateHeight(line) : 1;
    if (estHeight != line.height) updateLineHeight(line, estHeight);
  }

  // Detach a line from the document tree and its markers.
  function cleanUpLine(line) {
    line.parent = null;
    detachMarkedSpans(line);
  }

  function extractLineClasses(type, output) {
    if (type) for (;;) {
      var lineClass = type.match(/(?:^|\s+)line-(background-)?(\S+)/);
      if (!lineClass) break;
      type = type.slice(0, lineClass.index) + type.slice(lineClass.index + lineClass[0].length);
      var prop = lineClass[1] ? "bgClass" : "textClass";
      if (output[prop] == null)
        output[prop] = lineClass[2];
      else if (!(new RegExp("(?:^|\s)" + lineClass[2] + "(?:$|\s)")).test(output[prop]))
        output[prop] += " " + lineClass[2];
    }
    return type;
  }

  function callBlankLine(mode, state) {
    if (mode.blankLine) return mode.blankLine(state);
    if (!mode.innerMode) return;
    var inner = CodeMirror.innerMode(mode, state);
    if (inner.mode.blankLine) return inner.mode.blankLine(inner.state);
  }

  function readToken(mode, stream, state) {
    for (var i = 0; i < 10; i++) {
      var style = mode.token(stream, state);
      if (stream.pos > stream.start) return style;
    }
    throw new Error("Mode " + mode.name + " failed to advance stream.");
  }

  // Run the given mode's parser over a line, calling f for each token.
  function runMode(cm, text, mode, state, f, lineClasses, forceToEnd) {
    var flattenSpans = mode.flattenSpans;
    if (flattenSpans == null) flattenSpans = cm.options.flattenSpans;
    var curStart = 0, curStyle = null;
    var stream = new StringStream(text, cm.options.tabSize), style;
    if (text == "") extractLineClasses(callBlankLine(mode, state), lineClasses);
    while (!stream.eol()) {
      if (stream.pos > cm.options.maxHighlightLength) {
        flattenSpans = false;
        if (forceToEnd) processLine(cm, text, state, stream.pos);
        stream.pos = text.length;
        style = null;
      } else {
        style = extractLineClasses(readToken(mode, stream, state), lineClasses);
      }
      if (cm.options.addModeClass) {
        var mName = CodeMirror.innerMode(mode, state).mode.name;
        if (mName) style = "m-" + (style ? mName + " " + style : mName);
      }
      if (!flattenSpans || curStyle != style) {
        if (curStart < stream.start) f(stream.start, curStyle);
        curStart = stream.start; curStyle = style;
      }
      stream.start = stream.pos;
    }
    while (curStart < stream.pos) {
      // Webkit seems to refuse to render text nodes longer than 57444 characters
      var pos = Math.min(stream.pos, curStart + 50000);
      f(pos, curStyle);
      curStart = pos;
    }
  }

  // Compute a style array (an array starting with a mode generation
  // -- for invalidation -- followed by pairs of end positions and
  // style strings), which is used to highlight the tokens on the
  // line.
  function highlightLine(cm, line, state, forceToEnd) {
    // A styles array always starts with a number identifying the
    // mode/overlays that it is based on (for easy invalidation).
    var st = [cm.state.modeGen], lineClasses = {};
    // Compute the base array of styles
    runMode(cm, line.text, cm.doc.mode, state, function(end, style) {
      st.push(end, style);
    }, lineClasses, forceToEnd);

    // Run overlays, adjust style array.
    for (var o = 0; o < cm.state.overlays.length; ++o) {
      var overlay = cm.state.overlays[o], i = 1, at = 0;
      runMode(cm, line.text, overlay.mode, true, function(end, style) {
        var start = i;
        // Ensure there's a token end at the current position, and that i points at it
        while (at < end) {
          var i_end = st[i];
          if (i_end > end)
            st.splice(i, 1, end, st[i+1], i_end);
          i += 2;
          at = Math.min(end, i_end);
        }
        if (!style) return;
        if (overlay.opaque) {
          st.splice(start, i - start, end, "cm-overlay " + style);
          i = start + 2;
        } else {
          for (; start < i; start += 2) {
            var cur = st[start+1];
            st[start+1] = (cur ? cur + " " : "") + "cm-overlay " + style;
          }
        }
      }, lineClasses);
    }

    return {styles: st, classes: lineClasses.bgClass || lineClasses.textClass ? lineClasses : null};
  }

  function getLineStyles(cm, line) {
    if (!line.styles || line.styles[0] != cm.state.modeGen) {
      var result = highlightLine(cm, line, line.stateAfter = getStateBefore(cm, lineNo(line)));
      line.styles = result.styles;
      if (result.classes) line.styleClasses = result.classes;
      else if (line.styleClasses) line.styleClasses = null;
    }
    return line.styles;
  }

  // Lightweight form of highlight -- proceed over this line and
  // update state, but don't save a style array. Used for lines that
  // aren't currently visible.
  function processLine(cm, text, state, startAt) {
    var mode = cm.doc.mode;
    var stream = new StringStream(text, cm.options.tabSize);
    stream.start = stream.pos = startAt || 0;
    if (text == "") callBlankLine(mode, state);
    while (!stream.eol() && stream.pos <= cm.options.maxHighlightLength) {
      readToken(mode, stream, state);
      stream.start = stream.pos;
    }
  }

  // Convert a style as returned by a mode (either null, or a string
  // containing one or more styles) to a CSS style. This is cached,
  // and also looks for line-wide styles.
  var styleToClassCache = {}, styleToClassCacheWithMode = {};
  function interpretTokenStyle(style, options) {
    if (!style || /^\s*$/.test(style)) return null;
    var cache = options.addModeClass ? styleToClassCacheWithMode : styleToClassCache;
    return cache[style] ||
      (cache[style] = style.replace(/\S+/g, "cm-$&"));
  }

  // Render the DOM representation of the text of a line. Also builds
  // up a 'line map', which points at the DOM nodes that represent
  // specific stretches of text, and is used by the measuring code.
  // The returned object contains the DOM node, this map, and
  // information about line-wide styles that were set by the mode.
  function buildLineContent(cm, lineView) {
    // The padding-right forces the element to have a 'border', which
    // is needed on Webkit to be able to get line-level bounding
    // rectangles for it (in measureChar).
    var content = elt("span", null, null, webkit ? "padding-right: .1px" : null);
    var builder = {pre: elt("pre", [content]), content: content, col: 0, pos: 0, cm: cm};
    lineView.measure = {};

    // Iterate over the logical lines that make up this visual line.
    for (var i = 0; i <= (lineView.rest ? lineView.rest.length : 0); i++) {
      var line = i ? lineView.rest[i - 1] : lineView.line, order;
      builder.pos = 0;
      builder.addToken = buildToken;
      // Optionally wire in some hacks into the token-rendering
      // algorithm, to deal with browser quirks.
      if ((ie || webkit) && cm.getOption("lineWrapping"))
        builder.addToken = buildTokenSplitSpaces(builder.addToken);
      if (hasBadBidiRects(cm.display.measure) && (order = getOrder(line)))
        builder.addToken = buildTokenBadBidi(builder.addToken, order);
      builder.map = [];
      insertLineContent(line, builder, getLineStyles(cm, line));
      if (line.styleClasses) {
        if (line.styleClasses.bgClass)
          builder.bgClass = joinClasses(line.styleClasses.bgClass, builder.bgClass || "");
        if (line.styleClasses.textClass)
          builder.textClass = joinClasses(line.styleClasses.textClass, builder.textClass || "");
      }

      // Ensure at least a single node is present, for measuring.
      if (builder.map.length == 0)
        builder.map.push(0, 0, builder.content.appendChild(zeroWidthElement(cm.display.measure)));

      // Store the map and a cache object for the current logical line
      if (i == 0) {
        lineView.measure.map = builder.map;
        lineView.measure.cache = {};
      } else {
        (lineView.measure.maps || (lineView.measure.maps = [])).push(builder.map);
        (lineView.measure.caches || (lineView.measure.caches = [])).push({});
      }
    }

    signal(cm, "renderLine", cm, lineView.line, builder.pre);
    if (builder.pre.className)
      builder.textClass = joinClasses(builder.pre.className, builder.textClass || "");
    return builder;
  }

  function defaultSpecialCharPlaceholder(ch) {
    var token = elt("span", "\u2022", "cm-invalidchar");
    token.title = "\\u" + ch.charCodeAt(0).toString(16);
    return token;
  }

  // Build up the DOM representation for a single token, and add it to
  // the line map. Takes care to render special characters separately.
  function buildToken(builder, text, style, startStyle, endStyle, title) {
    if (!text) return;
    var special = builder.cm.options.specialChars, mustWrap = false;
    if (!special.test(text)) {
      builder.col += text.length;
      var content = document.createTextNode(text);
      builder.map.push(builder.pos, builder.pos + text.length, content);
      if (ie && ie_version < 9) mustWrap = true;
      builder.pos += text.length;
    } else {
      var content = document.createDocumentFragment(), pos = 0;
      while (true) {
        special.lastIndex = pos;
        var m = special.exec(text);
        var skipped = m ? m.index - pos : text.length - pos;
        if (skipped) {
          var txt = document.createTextNode(text.slice(pos, pos + skipped));
          if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
          else content.appendChild(txt);
          builder.map.push(builder.pos, builder.pos + skipped, txt);
          builder.col += skipped;
          builder.pos += skipped;
        }
        if (!m) break;
        pos += skipped + 1;
        if (m[0] == "\t") {
          var tabSize = builder.cm.options.tabSize, tabWidth = tabSize - builder.col % tabSize;
          var txt = content.appendChild(elt("span", spaceStr(tabWidth), "cm-tab"));
          builder.col += tabWidth;
        } else {
          var txt = builder.cm.options.specialCharPlaceholder(m[0]);
          if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
          else content.appendChild(txt);
          builder.col += 1;
        }
        builder.map.push(builder.pos, builder.pos + 1, txt);
        builder.pos++;
      }
    }
    if (style || startStyle || endStyle || mustWrap) {
      var fullStyle = style || "";
      if (startStyle) fullStyle += startStyle;
      if (endStyle) fullStyle += endStyle;
      var token = elt("span", [content], fullStyle);
      if (title) token.title = title;
      return builder.content.appendChild(token);
    }
    builder.content.appendChild(content);
  }

  function buildTokenSplitSpaces(inner) {
    function split(old) {
      var out = " ";
      for (var i = 0; i < old.length - 2; ++i) out += i % 2 ? " " : "\u00a0";
      out += " ";
      return out;
    }
    return function(builder, text, style, startStyle, endStyle, title) {
      inner(builder, text.replace(/ {3,}/g, split), style, startStyle, endStyle, title);
    };
  }

  // Work around nonsense dimensions being reported for stretches of
  // right-to-left text.
  function buildTokenBadBidi(inner, order) {
    return function(builder, text, style, startStyle, endStyle, title) {
      style = style ? style + " cm-force-border" : "cm-force-border";
      var start = builder.pos, end = start + text.length;
      for (;;) {
        // Find the part that overlaps with the start of this text
        for (var i = 0; i < order.length; i++) {
          var part = order[i];
          if (part.to > start && part.from <= start) break;
        }
        if (part.to >= end) return inner(builder, text, style, startStyle, endStyle, title);
        inner(builder, text.slice(0, part.to - start), style, startStyle, null, title);
        startStyle = null;
        text = text.slice(part.to - start);
        start = part.to;
      }
    };
  }

  function buildCollapsedSpan(builder, size, marker, ignoreWidget) {
    var widget = !ignoreWidget && marker.widgetNode;
    if (widget) {
      builder.map.push(builder.pos, builder.pos + size, widget);
      builder.content.appendChild(widget);
    }
    builder.pos += size;
  }

  // Outputs a number of spans to make up a line, taking highlighting
  // and marked text into account.
  function insertLineContent(line, builder, styles) {
    var spans = line.markedSpans, allText = line.text, at = 0;
    if (!spans) {
      for (var i = 1; i < styles.length; i+=2)
        builder.addToken(builder, allText.slice(at, at = styles[i]), interpretTokenStyle(styles[i+1], builder.cm.options));
      return;
    }

    var len = allText.length, pos = 0, i = 1, text = "", style;
    var nextChange = 0, spanStyle, spanEndStyle, spanStartStyle, title, collapsed;
    for (;;) {
      if (nextChange == pos) { // Update current marker set
        spanStyle = spanEndStyle = spanStartStyle = title = "";
        collapsed = null; nextChange = Infinity;
        var foundBookmarks = [];
        for (var j = 0; j < spans.length; ++j) {
          var sp = spans[j], m = sp.marker;
          if (sp.from <= pos && (sp.to == null || sp.to > pos)) {
            if (sp.to != null && nextChange > sp.to) { nextChange = sp.to; spanEndStyle = ""; }
            if (m.className) spanStyle += " " + m.className;
            if (m.startStyle && sp.from == pos) spanStartStyle += " " + m.startStyle;
            if (m.endStyle && sp.to == nextChange) spanEndStyle += " " + m.endStyle;
            if (m.title && !title) title = m.title;
            if (m.collapsed && (!collapsed || compareCollapsedMarkers(collapsed.marker, m) < 0))
              collapsed = sp;
          } else if (sp.from > pos && nextChange > sp.from) {
            nextChange = sp.from;
          }
          if (m.type == "bookmark" && sp.from == pos && m.widgetNode) foundBookmarks.push(m);
        }
        if (collapsed && (collapsed.from || 0) == pos) {
          buildCollapsedSpan(builder, (collapsed.to == null ? len + 1 : collapsed.to) - pos,
                             collapsed.marker, collapsed.from == null);
          if (collapsed.to == null) return;
        }
        if (!collapsed && foundBookmarks.length) for (var j = 0; j < foundBookmarks.length; ++j)
          buildCollapsedSpan(builder, 0, foundBookmarks[j]);
      }
      if (pos >= len) break;

      var upto = Math.min(len, nextChange);
      while (true) {
        if (text) {
          var end = pos + text.length;
          if (!collapsed) {
            var tokenText = end > upto ? text.slice(0, upto - pos) : text;
            builder.addToken(builder, tokenText, style ? style + spanStyle : spanStyle,
                             spanStartStyle, pos + tokenText.length == nextChange ? spanEndStyle : "", title);
          }
          if (end >= upto) {text = text.slice(upto - pos); pos = upto; break;}
          pos = end;
          spanStartStyle = "";
        }
        text = allText.slice(at, at = styles[i++]);
        style = interpretTokenStyle(styles[i++], builder.cm.options);
      }
    }
  }

  // DOCUMENT DATA STRUCTURE

  // By default, updates that start and end at the beginning of a line
  // are treated specially, in order to make the association of line
  // widgets and marker elements with the text behave more intuitive.
  function isWholeLineUpdate(doc, change) {
    return change.from.ch == 0 && change.to.ch == 0 && lst(change.text) == "" &&
      (!doc.cm || doc.cm.options.wholeLineUpdateBefore);
  }

  // Perform a change on the document data structure.
  function updateDoc(doc, change, markedSpans, estimateHeight) {
    function spansFor(n) {return markedSpans ? markedSpans[n] : null;}
    function update(line, text, spans) {
      updateLine(line, text, spans, estimateHeight);
      signalLater(line, "change", line, change);
    }

    var from = change.from, to = change.to, text = change.text;
    var firstLine = getLine(doc, from.line), lastLine = getLine(doc, to.line);
    var lastText = lst(text), lastSpans = spansFor(text.length - 1), nlines = to.line - from.line;

    // Adjust the line structure
    if (isWholeLineUpdate(doc, change)) {
      // This is a whole-line replace. Treated specially to make
      // sure line objects move the way they are supposed to.
      for (var i = 0, added = []; i < text.length - 1; ++i)
        added.push(new Line(text[i], spansFor(i), estimateHeight));
      update(lastLine, lastLine.text, lastSpans);
      if (nlines) doc.remove(from.line, nlines);
      if (added.length) doc.insert(from.line, added);
    } else if (firstLine == lastLine) {
      if (text.length == 1) {
        update(firstLine, firstLine.text.slice(0, from.ch) + lastText + firstLine.text.slice(to.ch), lastSpans);
      } else {
        for (var added = [], i = 1; i < text.length - 1; ++i)
          added.push(new Line(text[i], spansFor(i), estimateHeight));
        added.push(new Line(lastText + firstLine.text.slice(to.ch), lastSpans, estimateHeight));
        update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
        doc.insert(from.line + 1, added);
      }
    } else if (text.length == 1) {
      update(firstLine, firstLine.text.slice(0, from.ch) + text[0] + lastLine.text.slice(to.ch), spansFor(0));
      doc.remove(from.line + 1, nlines);
    } else {
      update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
      update(lastLine, lastText + lastLine.text.slice(to.ch), lastSpans);
      for (var i = 1, added = []; i < text.length - 1; ++i)
        added.push(new Line(text[i], spansFor(i), estimateHeight));
      if (nlines > 1) doc.remove(from.line + 1, nlines - 1);
      doc.insert(from.line + 1, added);
    }

    signalLater(doc, "change", doc, change);
  }

  // The document is represented as a BTree consisting of leaves, with
  // chunk of lines in them, and branches, with up to ten leaves or
  // other branch nodes below them. The top node is always a branch
  // node, and is the document object itself (meaning it has
  // additional methods and properties).
  //
  // All nodes have parent links. The tree is used both to go from
  // line numbers to line objects, and to go from objects to numbers.
  // It also indexes by height, and is used to convert between height
  // and line object, and to find the total height of the document.
  //
  // See also http://marijnhaverbeke.nl/blog/codemirror-line-tree.html

  function LeafChunk(lines) {
    this.lines = lines;
    this.parent = null;
    for (var i = 0, height = 0; i < lines.length; ++i) {
      lines[i].parent = this;
      height += lines[i].height;
    }
    this.height = height;
  }

  LeafChunk.prototype = {
    chunkSize: function() { return this.lines.length; },
    // Remove the n lines at offset 'at'.
    removeInner: function(at, n) {
      for (var i = at, e = at + n; i < e; ++i) {
        var line = this.lines[i];
        this.height -= line.height;
        cleanUpLine(line);
        signalLater(line, "delete");
      }
      this.lines.splice(at, n);
    },
    // Helper used to collapse a small branch into a single leaf.
    collapse: function(lines) {
      lines.push.apply(lines, this.lines);
    },
    // Insert the given array of lines at offset 'at', count them as
    // having the given height.
    insertInner: function(at, lines, height) {
      this.height += height;
      this.lines = this.lines.slice(0, at).concat(lines).concat(this.lines.slice(at));
      for (var i = 0; i < lines.length; ++i) lines[i].parent = this;
    },
    // Used to iterate over a part of the tree.
    iterN: function(at, n, op) {
      for (var e = at + n; at < e; ++at)
        if (op(this.lines[at])) return true;
    }
  };

  function BranchChunk(children) {
    this.children = children;
    var size = 0, height = 0;
    for (var i = 0; i < children.length; ++i) {
      var ch = children[i];
      size += ch.chunkSize(); height += ch.height;
      ch.parent = this;
    }
    this.size = size;
    this.height = height;
    this.parent = null;
  }

  BranchChunk.prototype = {
    chunkSize: function() { return this.size; },
    removeInner: function(at, n) {
      this.size -= n;
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at < sz) {
          var rm = Math.min(n, sz - at), oldHeight = child.height;
          child.removeInner(at, rm);
          this.height -= oldHeight - child.height;
          if (sz == rm) { this.children.splice(i--, 1); child.parent = null; }
          if ((n -= rm) == 0) break;
          at = 0;
        } else at -= sz;
      }
      // If the result is smaller than 25 lines, ensure that it is a
      // single leaf node.
      if (this.size - n < 25 &&
          (this.children.length > 1 || !(this.children[0] instanceof LeafChunk))) {
        var lines = [];
        this.collapse(lines);
        this.children = [new LeafChunk(lines)];
        this.children[0].parent = this;
      }
    },
    collapse: function(lines) {
      for (var i = 0; i < this.children.length; ++i) this.children[i].collapse(lines);
    },
    insertInner: function(at, lines, height) {
      this.size += lines.length;
      this.height += height;
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at <= sz) {
          child.insertInner(at, lines, height);
          if (child.lines && child.lines.length > 50) {
            while (child.lines.length > 50) {
              var spilled = child.lines.splice(child.lines.length - 25, 25);
              var newleaf = new LeafChunk(spilled);
              child.height -= newleaf.height;
              this.children.splice(i + 1, 0, newleaf);
              newleaf.parent = this;
            }
            this.maybeSpill();
          }
          break;
        }
        at -= sz;
      }
    },
    // When a node has grown, check whether it should be split.
    maybeSpill: function() {
      if (this.children.length <= 10) return;
      var me = this;
      do {
        var spilled = me.children.splice(me.children.length - 5, 5);
        var sibling = new BranchChunk(spilled);
        if (!me.parent) { // Become the parent node
          var copy = new BranchChunk(me.children);
          copy.parent = me;
          me.children = [copy, sibling];
          me = copy;
        } else {
          me.size -= sibling.size;
          me.height -= sibling.height;
          var myIndex = indexOf(me.parent.children, me);
          me.parent.children.splice(myIndex + 1, 0, sibling);
        }
        sibling.parent = me.parent;
      } while (me.children.length > 10);
      me.parent.maybeSpill();
    },
    iterN: function(at, n, op) {
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at < sz) {
          var used = Math.min(n, sz - at);
          if (child.iterN(at, used, op)) return true;
          if ((n -= used) == 0) break;
          at = 0;
        } else at -= sz;
      }
    }
  };

  var nextDocId = 0;
  var Doc = CodeMirror.Doc = function(text, mode, firstLine) {
    if (!(this instanceof Doc)) return new Doc(text, mode, firstLine);
    if (firstLine == null) firstLine = 0;

    BranchChunk.call(this, [new LeafChunk([new Line("", null)])]);
    this.first = firstLine;
    this.scrollTop = this.scrollLeft = 0;
    this.cantEdit = false;
    this.cleanGeneration = 1;
    this.frontier = firstLine;
    var start = Pos(firstLine, 0);
    this.sel = simpleSelection(start);
    this.history = new History(null);
    this.id = ++nextDocId;
    this.modeOption = mode;

    if (typeof text == "string") text = splitLines(text);
    updateDoc(this, {from: start, to: start, text: text});
    setSelection(this, simpleSelection(start), sel_dontScroll);
  };

  Doc.prototype = createObj(BranchChunk.prototype, {
    constructor: Doc,
    // Iterate over the document. Supports two forms -- with only one
    // argument, it calls that for each line in the document. With
    // three, it iterates over the range given by the first two (with
    // the second being non-inclusive).
    iter: function(from, to, op) {
      if (op) this.iterN(from - this.first, to - from, op);
      else this.iterN(this.first, this.first + this.size, from);
    },

    // Non-public interface for adding and removing lines.
    insert: function(at, lines) {
      var height = 0;
      for (var i = 0; i < lines.length; ++i) height += lines[i].height;
      this.insertInner(at - this.first, lines, height);
    },
    remove: function(at, n) { this.removeInner(at - this.first, n); },

    // From here, the methods are part of the public interface. Most
    // are also available from CodeMirror (editor) instances.

    getValue: function(lineSep) {
      var lines = getLines(this, this.first, this.first + this.size);
      if (lineSep === false) return lines;
      return lines.join(lineSep || "\n");
    },
    setValue: docMethodOp(function(code) {
      var top = Pos(this.first, 0), last = this.first + this.size - 1;
      makeChange(this, {from: top, to: Pos(last, getLine(this, last).text.length),
                        text: splitLines(code), origin: "setValue"}, true);
      setSelection(this, simpleSelection(top));
    }),
    replaceRange: function(code, from, to, origin) {
      from = clipPos(this, from);
      to = to ? clipPos(this, to) : from;
      replaceRange(this, code, from, to, origin);
    },
    getRange: function(from, to, lineSep) {
      var lines = getBetween(this, clipPos(this, from), clipPos(this, to));
      if (lineSep === false) return lines;
      return lines.join(lineSep || "\n");
    },

    getLine: function(line) {var l = this.getLineHandle(line); return l && l.text;},

    getLineHandle: function(line) {if (isLine(this, line)) return getLine(this, line);},
    getLineNumber: function(line) {return lineNo(line);},

    getLineHandleVisualStart: function(line) {
      if (typeof line == "number") line = getLine(this, line);
      return visualLine(line);
    },

    lineCount: function() {return this.size;},
    firstLine: function() {return this.first;},
    lastLine: function() {return this.first + this.size - 1;},

    clipPos: function(pos) {return clipPos(this, pos);},

    getCursor: function(start) {
      var range = this.sel.primary(), pos;
      if (start == null || start == "head") pos = range.head;
      else if (start == "anchor") pos = range.anchor;
      else if (start == "end" || start == "to" || start === false) pos = range.to();
      else pos = range.from();
      return pos;
    },
    listSelections: function() { return this.sel.ranges; },
    somethingSelected: function() {return this.sel.somethingSelected();},

    setCursor: docMethodOp(function(line, ch, options) {
      setSimpleSelection(this, clipPos(this, typeof line == "number" ? Pos(line, ch || 0) : line), null, options);
    }),
    setSelection: docMethodOp(function(anchor, head, options) {
      setSimpleSelection(this, clipPos(this, anchor), clipPos(this, head || anchor), options);
    }),
    extendSelection: docMethodOp(function(head, other, options) {
      extendSelection(this, clipPos(this, head), other && clipPos(this, other), options);
    }),
    extendSelections: docMethodOp(function(heads, options) {
      extendSelections(this, clipPosArray(this, heads, options));
    }),
    extendSelectionsBy: docMethodOp(function(f, options) {
      extendSelections(this, map(this.sel.ranges, f), options);
    }),
    setSelections: docMethodOp(function(ranges, primary, options) {
      if (!ranges.length) return;
      for (var i = 0, out = []; i < ranges.length; i++)
        out[i] = new Range(clipPos(this, ranges[i].anchor),
                           clipPos(this, ranges[i].head));
      if (primary == null) primary = Math.min(ranges.length - 1, this.sel.primIndex);
      setSelection(this, normalizeSelection(out, primary), options);
    }),
    addSelection: docMethodOp(function(anchor, head, options) {
      var ranges = this.sel.ranges.slice(0);
      ranges.push(new Range(clipPos(this, anchor), clipPos(this, head || anchor)));
      setSelection(this, normalizeSelection(ranges, ranges.length - 1), options);
    }),

    getSelection: function(lineSep) {
      var ranges = this.sel.ranges, lines;
      for (var i = 0; i < ranges.length; i++) {
        var sel = getBetween(this, ranges[i].from(), ranges[i].to());
        lines = lines ? lines.concat(sel) : sel;
      }
      if (lineSep === false) return lines;
      else return lines.join(lineSep || "\n");
    },
    getSelections: function(lineSep) {
      var parts = [], ranges = this.sel.ranges;
      for (var i = 0; i < ranges.length; i++) {
        var sel = getBetween(this, ranges[i].from(), ranges[i].to());
        if (lineSep !== false) sel = sel.join(lineSep || "\n");
        parts[i] = sel;
      }
      return parts;
    },
    replaceSelection: function(code, collapse, origin) {
      var dup = [];
      for (var i = 0; i < this.sel.ranges.length; i++)
        dup[i] = code;
      this.replaceSelections(dup, collapse, origin || "+input");
    },
    replaceSelections: docMethodOp(function(code, collapse, origin) {
      var changes = [], sel = this.sel;
      for (var i = 0; i < sel.ranges.length; i++) {
        var range = sel.ranges[i];
        changes[i] = {from: range.from(), to: range.to(), text: splitLines(code[i]), origin: origin};
      }
      var newSel = collapse && collapse != "end" && computeReplacedSel(this, changes, collapse);
      for (var i = changes.length - 1; i >= 0; i--)
        makeChange(this, changes[i]);
      if (newSel) setSelectionReplaceHistory(this, newSel);
      else if (this.cm) ensureCursorVisible(this.cm);
    }),
    undo: docMethodOp(function() {makeChangeFromHistory(this, "undo");}),
    redo: docMethodOp(function() {makeChangeFromHistory(this, "redo");}),
    undoSelection: docMethodOp(function() {makeChangeFromHistory(this, "undo", true);}),
    redoSelection: docMethodOp(function() {makeChangeFromHistory(this, "redo", true);}),

    setExtending: function(val) {this.extend = val;},
    getExtending: function() {return this.extend;},

    historySize: function() {
      var hist = this.history, done = 0, undone = 0;
      for (var i = 0; i < hist.done.length; i++) if (!hist.done[i].ranges) ++done;
      for (var i = 0; i < hist.undone.length; i++) if (!hist.undone[i].ranges) ++undone;
      return {undo: done, redo: undone};
    },
    clearHistory: function() {this.history = new History(this.history.maxGeneration);},

    markClean: function() {
      this.cleanGeneration = this.changeGeneration(true);
    },
    changeGeneration: function(forceSplit) {
      if (forceSplit)
        this.history.lastOp = this.history.lastOrigin = null;
      return this.history.generation;
    },
    isClean: function (gen) {
      return this.history.generation == (gen || this.cleanGeneration);
    },

    getHistory: function() {
      return {done: copyHistoryArray(this.history.done),
              undone: copyHistoryArray(this.history.undone)};
    },
    setHistory: function(histData) {
      var hist = this.history = new History(this.history.maxGeneration);
      hist.done = copyHistoryArray(histData.done.slice(0), null, true);
      hist.undone = copyHistoryArray(histData.undone.slice(0), null, true);
    },

    addLineClass: docMethodOp(function(handle, where, cls) {
      return changeLine(this, handle, "class", function(line) {
        var prop = where == "text" ? "textClass" : where == "background" ? "bgClass" : "wrapClass";
        if (!line[prop]) line[prop] = cls;
        else if (new RegExp("(?:^|\\s)" + cls + "(?:$|\\s)").test(line[prop])) return false;
        else line[prop] += " " + cls;
        return true;
      });
    }),
    removeLineClass: docMethodOp(function(handle, where, cls) {
      return changeLine(this, handle, "class", function(line) {
        var prop = where == "text" ? "textClass" : where == "background" ? "bgClass" : "wrapClass";
        var cur = line[prop];
        if (!cur) return false;
        else if (cls == null) line[prop] = null;
        else {
          var found = cur.match(new RegExp("(?:^|\\s+)" + cls + "(?:$|\\s+)"));
          if (!found) return false;
          var end = found.index + found[0].length;
          line[prop] = cur.slice(0, found.index) + (!found.index || end == cur.length ? "" : " ") + cur.slice(end) || null;
        }
        return true;
      });
    }),

    markText: function(from, to, options) {
      return markText(this, clipPos(this, from), clipPos(this, to), options, "range");
    },
    setBookmark: function(pos, options) {
      var realOpts = {replacedWith: options && (options.nodeType == null ? options.widget : options),
                      insertLeft: options && options.insertLeft,
                      clearWhenEmpty: false, shared: options && options.shared};
      pos = clipPos(this, pos);
      return markText(this, pos, pos, realOpts, "bookmark");
    },
    findMarksAt: function(pos) {
      pos = clipPos(this, pos);
      var markers = [], spans = getLine(this, pos.line).markedSpans;
      if (spans) for (var i = 0; i < spans.length; ++i) {
        var span = spans[i];
        if ((span.from == null || span.from <= pos.ch) &&
            (span.to == null || span.to >= pos.ch))
          markers.push(span.marker.parent || span.marker);
      }
      return markers;
    },
    findMarks: function(from, to, filter) {
      from = clipPos(this, from); to = clipPos(this, to);
      var found = [], lineNo = from.line;
      this.iter(from.line, to.line + 1, function(line) {
        var spans = line.markedSpans;
        if (spans) for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          if (!(lineNo == from.line && from.ch > span.to ||
                span.from == null && lineNo != from.line||
                lineNo == to.line && span.from > to.ch) &&
              (!filter || filter(span.marker)))
            found.push(span.marker.parent || span.marker);
        }
        ++lineNo;
      });
      return found;
    },
    getAllMarks: function() {
      var markers = [];
      this.iter(function(line) {
        var sps = line.markedSpans;
        if (sps) for (var i = 0; i < sps.length; ++i)
          if (sps[i].from != null) markers.push(sps[i].marker);
      });
      return markers;
    },

    posFromIndex: function(off) {
      var ch, lineNo = this.first;
      this.iter(function(line) {
        var sz = line.text.length + 1;
        if (sz > off) { ch = off; return true; }
        off -= sz;
        ++lineNo;
      });
      return clipPos(this, Pos(lineNo, ch));
    },
    indexFromPos: function (coords) {
      coords = clipPos(this, coords);
      var index = coords.ch;
      if (coords.line < this.first || coords.ch < 0) return 0;
      this.iter(this.first, coords.line, function (line) {
        index += line.text.length + 1;
      });
      return index;
    },

    copy: function(copyHistory) {
      var doc = new Doc(getLines(this, this.first, this.first + this.size), this.modeOption, this.first);
      doc.scrollTop = this.scrollTop; doc.scrollLeft = this.scrollLeft;
      doc.sel = this.sel;
      doc.extend = false;
      if (copyHistory) {
        doc.history.undoDepth = this.history.undoDepth;
        doc.setHistory(this.getHistory());
      }
      return doc;
    },

    linkedDoc: function(options) {
      if (!options) options = {};
      var from = this.first, to = this.first + this.size;
      if (options.from != null && options.from > from) from = options.from;
      if (options.to != null && options.to < to) to = options.to;
      var copy = new Doc(getLines(this, from, to), options.mode || this.modeOption, from);
      if (options.sharedHist) copy.history = this.history;
      (this.linked || (this.linked = [])).push({doc: copy, sharedHist: options.sharedHist});
      copy.linked = [{doc: this, isParent: true, sharedHist: options.sharedHist}];
      copySharedMarkers(copy, findSharedMarkers(this));
      return copy;
    },
    unlinkDoc: function(other) {
      if (other instanceof CodeMirror) other = other.doc;
      if (this.linked) for (var i = 0; i < this.linked.length; ++i) {
        var link = this.linked[i];
        if (link.doc != other) continue;
        this.linked.splice(i, 1);
        other.unlinkDoc(this);
        detachSharedMarkers(findSharedMarkers(this));
        break;
      }
      // If the histories were shared, split them again
      if (other.history == this.history) {
        var splitIds = [other.id];
        linkedDocs(other, function(doc) {splitIds.push(doc.id);}, true);
        other.history = new History(null);
        other.history.done = copyHistoryArray(this.history.done, splitIds);
        other.history.undone = copyHistoryArray(this.history.undone, splitIds);
      }
    },
    iterLinkedDocs: function(f) {linkedDocs(this, f);},

    getMode: function() {return this.mode;},
    getEditor: function() {return this.cm;}
  });

  // Public alias.
  Doc.prototype.eachLine = Doc.prototype.iter;

  // Set up methods on CodeMirror's prototype to redirect to the editor's document.
  var dontDelegate = "iter insert remove copy getEditor".split(" ");
  for (var prop in Doc.prototype) if (Doc.prototype.hasOwnProperty(prop) && indexOf(dontDelegate, prop) < 0)
    CodeMirror.prototype[prop] = (function(method) {
      return function() {return method.apply(this.doc, arguments);};
    })(Doc.prototype[prop]);

  eventMixin(Doc);

  // Call f for all linked documents.
  function linkedDocs(doc, f, sharedHistOnly) {
    function propagate(doc, skip, sharedHist) {
      if (doc.linked) for (var i = 0; i < doc.linked.length; ++i) {
        var rel = doc.linked[i];
        if (rel.doc == skip) continue;
        var shared = sharedHist && rel.sharedHist;
        if (sharedHistOnly && !shared) continue;
        f(rel.doc, shared);
        propagate(rel.doc, doc, shared);
      }
    }
    propagate(doc, null, true);
  }

  // Attach a document to an editor.
  function attachDoc(cm, doc) {
    if (doc.cm) throw new Error("This document is already in use.");
    cm.doc = doc;
    doc.cm = cm;
    estimateLineHeights(cm);
    loadMode(cm);
    if (!cm.options.lineWrapping) findMaxLine(cm);
    cm.options.mode = doc.modeOption;
    regChange(cm);
  }

  // LINE UTILITIES

  // Find the line object corresponding to the given line number.
  function getLine(doc, n) {
    n -= doc.first;
    if (n < 0 || n >= doc.size) throw new Error("There is no line " + (n + doc.first) + " in the document.");
    for (var chunk = doc; !chunk.lines;) {
      for (var i = 0;; ++i) {
        var child = chunk.children[i], sz = child.chunkSize();
        if (n < sz) { chunk = child; break; }
        n -= sz;
      }
    }
    return chunk.lines[n];
  }

  // Get the part of a document between two positions, as an array of
  // strings.
  function getBetween(doc, start, end) {
    var out = [], n = start.line;
    doc.iter(start.line, end.line + 1, function(line) {
      var text = line.text;
      if (n == end.line) text = text.slice(0, end.ch);
      if (n == start.line) text = text.slice(start.ch);
      out.push(text);
      ++n;
    });
    return out;
  }
  // Get the lines between from and to, as array of strings.
  function getLines(doc, from, to) {
    var out = [];
    doc.iter(from, to, function(line) { out.push(line.text); });
    return out;
  }

  // Update the height of a line, propagating the height change
  // upwards to parent nodes.
  function updateLineHeight(line, height) {
    var diff = height - line.height;
    if (diff) for (var n = line; n; n = n.parent) n.height += diff;
  }

  // Given a line object, find its line number by walking up through
  // its parent links.
  function lineNo(line) {
    if (line.parent == null) return null;
    var cur = line.parent, no = indexOf(cur.lines, line);
    for (var chunk = cur.parent; chunk; cur = chunk, chunk = chunk.parent) {
      for (var i = 0;; ++i) {
        if (chunk.children[i] == cur) break;
        no += chunk.children[i].chunkSize();
      }
    }
    return no + cur.first;
  }

  // Find the line at the given vertical position, using the height
  // information in the document tree.
  function lineAtHeight(chunk, h) {
    var n = chunk.first;
    outer: do {
      for (var i = 0; i < chunk.children.length; ++i) {
        var child = chunk.children[i], ch = child.height;
        if (h < ch) { chunk = child; continue outer; }
        h -= ch;
        n += child.chunkSize();
      }
      return n;
    } while (!chunk.lines);
    for (var i = 0; i < chunk.lines.length; ++i) {
      var line = chunk.lines[i], lh = line.height;
      if (h < lh) break;
      h -= lh;
    }
    return n + i;
  }


  // Find the height above the given line.
  function heightAtLine(lineObj) {
    lineObj = visualLine(lineObj);

    var h = 0, chunk = lineObj.parent;
    for (var i = 0; i < chunk.lines.length; ++i) {
      var line = chunk.lines[i];
      if (line == lineObj) break;
      else h += line.height;
    }
    for (var p = chunk.parent; p; chunk = p, p = chunk.parent) {
      for (var i = 0; i < p.children.length; ++i) {
        var cur = p.children[i];
        if (cur == chunk) break;
        else h += cur.height;
      }
    }
    return h;
  }

  // Get the bidi ordering for the given line (and cache it). Returns
  // false for lines that are fully left-to-right, and an array of
  // BidiSpan objects otherwise.
  function getOrder(line) {
    var order = line.order;
    if (order == null) order = line.order = bidiOrdering(line.text);
    return order;
  }

  // HISTORY

  function History(startGen) {
    // Arrays of change events and selections. Doing something adds an
    // event to done and clears undo. Undoing moves events from done
    // to undone, redoing moves them in the other direction.
    this.done = []; this.undone = [];
    this.undoDepth = Infinity;
    // Used to track when changes can be merged into a single undo
    // event
    this.lastModTime = this.lastSelTime = 0;
    this.lastOp = null;
    this.lastOrigin = this.lastSelOrigin = null;
    // Used by the isClean() method
    this.generation = this.maxGeneration = startGen || 1;
  }

  // Create a history change event from an updateDoc-style change
  // object.
  function historyChangeFromChange(doc, change) {
    var histChange = {from: copyPos(change.from), to: changeEnd(change), text: getBetween(doc, change.from, change.to)};
    attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);
    linkedDocs(doc, function(doc) {attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);}, true);
    return histChange;
  }

  // Pop all selection events off the end of a history array. Stop at
  // a change event.
  function clearSelectionEvents(array) {
    while (array.length) {
      var last = lst(array);
      if (last.ranges) array.pop();
      else break;
    }
  }

  // Find the top change event in the history. Pop off selection
  // events that are in the way.
  function lastChangeEvent(hist, force) {
    if (force) {
      clearSelectionEvents(hist.done);
      return lst(hist.done);
    } else if (hist.done.length && !lst(hist.done).ranges) {
      return lst(hist.done);
    } else if (hist.done.length > 1 && !hist.done[hist.done.length - 2].ranges) {
      hist.done.pop();
      return lst(hist.done);
    }
  }

  // Register a change in the history. Merges changes that are within
  // a single operation, ore are close together with an origin that
  // allows merging (starting with "+") into a single event.
  function addChangeToHistory(doc, change, selAfter, opId) {
    var hist = doc.history;
    hist.undone.length = 0;
    var time = +new Date, cur;

    if ((hist.lastOp == opId ||
         hist.lastOrigin == change.origin && change.origin &&
         ((change.origin.charAt(0) == "+" && doc.cm && hist.lastModTime > time - doc.cm.options.historyEventDelay) ||
          change.origin.charAt(0) == "*")) &&
        (cur = lastChangeEvent(hist, hist.lastOp == opId))) {
      // Merge this change into the last event
      var last = lst(cur.changes);
      if (cmp(change.from, change.to) == 0 && cmp(change.from, last.to) == 0) {
        // Optimized case for simple insertion -- don't want to add
        // new changesets for every character typed
        last.to = changeEnd(change);
      } else {
        // Add new sub-event
        cur.changes.push(historyChangeFromChange(doc, change));
      }
    } else {
      // Can not be merged, start a new event.
      var before = lst(hist.done);
      if (!before || !before.ranges)
        pushSelectionToHistory(doc.sel, hist.done);
      cur = {changes: [historyChangeFromChange(doc, change)],
             generation: hist.generation};
      hist.done.push(cur);
      while (hist.done.length > hist.undoDepth) {
        hist.done.shift();
        if (!hist.done[0].ranges) hist.done.shift();
      }
    }
    hist.done.push(selAfter);
    hist.generation = ++hist.maxGeneration;
    hist.lastModTime = hist.lastSelTime = time;
    hist.lastOp = opId;
    hist.lastOrigin = hist.lastSelOrigin = change.origin;

    if (!last) signal(doc, "historyAdded");
  }

  function selectionEventCanBeMerged(doc, origin, prev, sel) {
    var ch = origin.charAt(0);
    return ch == "*" ||
      ch == "+" &&
      prev.ranges.length == sel.ranges.length &&
      prev.somethingSelected() == sel.somethingSelected() &&
      new Date - doc.history.lastSelTime <= (doc.cm ? doc.cm.options.historyEventDelay : 500);
  }

  // Called whenever the selection changes, sets the new selection as
  // the pending selection in the history, and pushes the old pending
  // selection into the 'done' array when it was significantly
  // different (in number of selected ranges, emptiness, or time).
  function addSelectionToHistory(doc, sel, opId, options) {
    var hist = doc.history, origin = options && options.origin;

    // A new event is started when the previous origin does not match
    // the current, or the origins don't allow matching. Origins
    // starting with * are always merged, those starting with + are
    // merged when similar and close together in time.
    if (opId == hist.lastOp ||
        (origin && hist.lastSelOrigin == origin &&
         (hist.lastModTime == hist.lastSelTime && hist.lastOrigin == origin ||
          selectionEventCanBeMerged(doc, origin, lst(hist.done), sel))))
      hist.done[hist.done.length - 1] = sel;
    else
      pushSelectionToHistory(sel, hist.done);

    hist.lastSelTime = +new Date;
    hist.lastSelOrigin = origin;
    hist.lastOp = opId;
    if (options && options.clearRedo !== false)
      clearSelectionEvents(hist.undone);
  }

  function pushSelectionToHistory(sel, dest) {
    var top = lst(dest);
    if (!(top && top.ranges && top.equals(sel)))
      dest.push(sel);
  }

  // Used to store marked span information in the history.
  function attachLocalSpans(doc, change, from, to) {
    var existing = change["spans_" + doc.id], n = 0;
    doc.iter(Math.max(doc.first, from), Math.min(doc.first + doc.size, to), function(line) {
      if (line.markedSpans)
        (existing || (existing = change["spans_" + doc.id] = {}))[n] = line.markedSpans;
      ++n;
    });
  }

  // When un/re-doing restores text containing marked spans, those
  // that have been explicitly cleared should not be restored.
  function removeClearedSpans(spans) {
    if (!spans) return null;
    for (var i = 0, out; i < spans.length; ++i) {
      if (spans[i].marker.explicitlyCleared) { if (!out) out = spans.slice(0, i); }
      else if (out) out.push(spans[i]);
    }
    return !out ? spans : out.length ? out : null;
  }

  // Retrieve and filter the old marked spans stored in a change event.
  function getOldSpans(doc, change) {
    var found = change["spans_" + doc.id];
    if (!found) return null;
    for (var i = 0, nw = []; i < change.text.length; ++i)
      nw.push(removeClearedSpans(found[i]));
    return nw;
  }

  // Used both to provide a JSON-safe object in .getHistory, and, when
  // detaching a document, to split the history in two
  function copyHistoryArray(events, newGroup, instantiateSel) {
    for (var i = 0, copy = []; i < events.length; ++i) {
      var event = events[i];
      if (event.ranges) {
        copy.push(instantiateSel ? Selection.prototype.deepCopy.call(event) : event);
        continue;
      }
      var changes = event.changes, newChanges = [];
      copy.push({changes: newChanges});
      for (var j = 0; j < changes.length; ++j) {
        var change = changes[j], m;
        newChanges.push({from: change.from, to: change.to, text: change.text});
        if (newGroup) for (var prop in change) if (m = prop.match(/^spans_(\d+)$/)) {
          if (indexOf(newGroup, Number(m[1])) > -1) {
            lst(newChanges)[prop] = change[prop];
            delete change[prop];
          }
        }
      }
    }
    return copy;
  }

  // Rebasing/resetting history to deal with externally-sourced changes

  function rebaseHistSelSingle(pos, from, to, diff) {
    if (to < pos.line) {
      pos.line += diff;
    } else if (from < pos.line) {
      pos.line = from;
      pos.ch = 0;
    }
  }

  // Tries to rebase an array of history events given a change in the
  // document. If the change touches the same lines as the event, the
  // event, and everything 'behind' it, is discarded. If the change is
  // before the event, the event's positions are updated. Uses a
  // copy-on-write scheme for the positions, to avoid having to
  // reallocate them all on every rebase, but also avoid problems with
  // shared position objects being unsafely updated.
  function rebaseHistArray(array, from, to, diff) {
    for (var i = 0; i < array.length; ++i) {
      var sub = array[i], ok = true;
      if (sub.ranges) {
        if (!sub.copied) { sub = array[i] = sub.deepCopy(); sub.copied = true; }
        for (var j = 0; j < sub.ranges.length; j++) {
          rebaseHistSelSingle(sub.ranges[j].anchor, from, to, diff);
          rebaseHistSelSingle(sub.ranges[j].head, from, to, diff);
        }
        continue;
      }
      for (var j = 0; j < sub.changes.length; ++j) {
        var cur = sub.changes[j];
        if (to < cur.from.line) {
          cur.from = Pos(cur.from.line + diff, cur.from.ch);
          cur.to = Pos(cur.to.line + diff, cur.to.ch);
        } else if (from <= cur.to.line) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        array.splice(0, i + 1);
        i = 0;
      }
    }
  }

  function rebaseHist(hist, change) {
    var from = change.from.line, to = change.to.line, diff = change.text.length - (to - from) - 1;
    rebaseHistArray(hist.done, from, to, diff);
    rebaseHistArray(hist.undone, from, to, diff);
  }

  // EVENT UTILITIES

  // Due to the fact that we still support jurassic IE versions, some
  // compatibility wrappers are needed.

  var e_preventDefault = CodeMirror.e_preventDefault = function(e) {
    if (e.preventDefault) e.preventDefault();
    else e.returnValue = false;
  };
  var e_stopPropagation = CodeMirror.e_stopPropagation = function(e) {
    if (e.stopPropagation) e.stopPropagation();
    else e.cancelBubble = true;
  };
  function e_defaultPrevented(e) {
    return e.defaultPrevented != null ? e.defaultPrevented : e.returnValue == false;
  }
  var e_stop = CodeMirror.e_stop = function(e) {e_preventDefault(e); e_stopPropagation(e);};

  function e_target(e) {return e.target || e.srcElement;}
  function e_button(e) {
    var b = e.which;
    if (b == null) {
      if (e.button & 1) b = 1;
      else if (e.button & 2) b = 3;
      else if (e.button & 4) b = 2;
    }
    if (mac && e.ctrlKey && b == 1) b = 3;
    return b;
  }

  // EVENT HANDLING

  // Lightweight event framework. on/off also work on DOM nodes,
  // registering native DOM handlers.

  var on = CodeMirror.on = function(emitter, type, f) {
    if (emitter.addEventListener)
      emitter.addEventListener(type, f, false);
    else if (emitter.attachEvent)
      emitter.attachEvent("on" + type, f);
    else {
      var map = emitter._handlers || (emitter._handlers = {});
      var arr = map[type] || (map[type] = []);
      arr.push(f);
    }
  };

  var off = CodeMirror.off = function(emitter, type, f) {
    if (emitter.removeEventListener)
      emitter.removeEventListener(type, f, false);
    else if (emitter.detachEvent)
      emitter.detachEvent("on" + type, f);
    else {
      var arr = emitter._handlers && emitter._handlers[type];
      if (!arr) return;
      for (var i = 0; i < arr.length; ++i)
        if (arr[i] == f) { arr.splice(i, 1); break; }
    }
  };

  var signal = CodeMirror.signal = function(emitter, type /*, values...*/) {
    var arr = emitter._handlers && emitter._handlers[type];
    if (!arr) return;
    var args = Array.prototype.slice.call(arguments, 2);
    for (var i = 0; i < arr.length; ++i) arr[i].apply(null, args);
  };

  // Often, we want to signal events at a point where we are in the
  // middle of some work, but don't want the handler to start calling
  // other methods on the editor, which might be in an inconsistent
  // state or simply not expect any other events to happen.
  // signalLater looks whether there are any handlers, and schedules
  // them to be executed when the last operation ends, or, if no
  // operation is active, when a timeout fires.
  var delayedCallbacks, delayedCallbackDepth = 0;
  function signalLater(emitter, type /*, values...*/) {
    var arr = emitter._handlers && emitter._handlers[type];
    if (!arr) return;
    var args = Array.prototype.slice.call(arguments, 2);
    if (!delayedCallbacks) {
      ++delayedCallbackDepth;
      delayedCallbacks = [];
      setTimeout(fireDelayed, 0);
    }
    function bnd(f) {return function(){f.apply(null, args);};};
    for (var i = 0; i < arr.length; ++i)
      delayedCallbacks.push(bnd(arr[i]));
  }

  function fireDelayed() {
    --delayedCallbackDepth;
    var delayed = delayedCallbacks;
    delayedCallbacks = null;
    for (var i = 0; i < delayed.length; ++i) delayed[i]();
  }

  // The DOM events that CodeMirror handles can be overridden by
  // registering a (non-DOM) handler on the editor for the event name,
  // and preventDefault-ing the event in that handler.
  function signalDOMEvent(cm, e, override) {
    signal(cm, override || e.type, cm, e);
    return e_defaultPrevented(e) || e.codemirrorIgnore;
  }

  function signalCursorActivity(cm) {
    var arr = cm._handlers && cm._handlers.cursorActivity;
    if (!arr) return;
    var set = cm.curOp.cursorActivityHandlers || (cm.curOp.cursorActivityHandlers = []);
    for (var i = 0; i < arr.length; ++i) if (indexOf(set, arr[i]) == -1)
      set.push(arr[i]);
  }

  function hasHandler(emitter, type) {
    var arr = emitter._handlers && emitter._handlers[type];
    return arr && arr.length > 0;
  }

  // Add on and off methods to a constructor's prototype, to make
  // registering events on such objects more convenient.
  function eventMixin(ctor) {
    ctor.prototype.on = function(type, f) {on(this, type, f);};
    ctor.prototype.off = function(type, f) {off(this, type, f);};
  }

  // MISC UTILITIES

  // Number of pixels added to scroller and sizer to hide scrollbar
  var scrollerCutOff = 30;

  // Returned or thrown by various protocols to signal 'I'm not
  // handling this'.
  var Pass = CodeMirror.Pass = {toString: function(){return "CodeMirror.Pass";}};

  // Reused option objects for setSelection & friends
  var sel_dontScroll = {scroll: false}, sel_mouse = {origin: "*mouse"}, sel_move = {origin: "+move"};

  function Delayed() {this.id = null;}
  Delayed.prototype.set = function(ms, f) {
    clearTimeout(this.id);
    this.id = setTimeout(f, ms);
  };

  // Counts the column offset in a string, taking tabs into account.
  // Used mostly to find indentation.
  var countColumn = CodeMirror.countColumn = function(string, end, tabSize, startIndex, startValue) {
    if (end == null) {
      end = string.search(/[^\s\u00a0]/);
      if (end == -1) end = string.length;
    }
    for (var i = startIndex || 0, n = startValue || 0;;) {
      var nextTab = string.indexOf("\t", i);
      if (nextTab < 0 || nextTab >= end)
        return n + (end - i);
      n += nextTab - i;
      n += tabSize - (n % tabSize);
      i = nextTab + 1;
    }
  };

  // The inverse of countColumn -- find the offset that corresponds to
  // a particular column.
  function findColumn(string, goal, tabSize) {
    for (var pos = 0, col = 0;;) {
      var nextTab = string.indexOf("\t", pos);
      if (nextTab == -1) nextTab = string.length;
      var skipped = nextTab - pos;
      if (nextTab == string.length || col + skipped >= goal)
        return pos + Math.min(skipped, goal - col);
      col += nextTab - pos;
      col += tabSize - (col % tabSize);
      pos = nextTab + 1;
      if (col >= goal) return pos;
    }
  }

  var spaceStrs = [""];
  function spaceStr(n) {
    while (spaceStrs.length <= n)
      spaceStrs.push(lst(spaceStrs) + " ");
    return spaceStrs[n];
  }

  function lst(arr) { return arr[arr.length-1]; }

  var selectInput = function(node) { node.select(); };
  if (ios) // Mobile Safari apparently has a bug where select() is broken.
    selectInput = function(node) { node.selectionStart = 0; node.selectionEnd = node.value.length; };
  else if (ie) // Suppress mysterious IE10 errors
    selectInput = function(node) { try { node.select(); } catch(_e) {} };

  function indexOf(array, elt) {
    for (var i = 0; i < array.length; ++i)
      if (array[i] == elt) return i;
    return -1;
  }
  if ([].indexOf) indexOf = function(array, elt) { return array.indexOf(elt); };
  function map(array, f) {
    var out = [];
    for (var i = 0; i < array.length; i++) out[i] = f(array[i], i);
    return out;
  }
  if ([].map) map = function(array, f) { return array.map(f); };

  function createObj(base, props) {
    var inst;
    if (Object.create) {
      inst = Object.create(base);
    } else {
      var ctor = function() {};
      ctor.prototype = base;
      inst = new ctor();
    }
    if (props) copyObj(props, inst);
    return inst;
  };

  function copyObj(obj, target, overwrite) {
    if (!target) target = {};
    for (var prop in obj)
      if (obj.hasOwnProperty(prop) && (overwrite !== false || !target.hasOwnProperty(prop)))
        target[prop] = obj[prop];
    return target;
  }

  function bind(f) {
    var args = Array.prototype.slice.call(arguments, 1);
    return function(){return f.apply(null, args);};
  }

  var nonASCIISingleCaseWordChar = /[\u00df\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;
  var isWordCharBasic = CodeMirror.isWordChar = function(ch) {
    return /\w/.test(ch) || ch > "\x80" &&
      (ch.toUpperCase() != ch.toLowerCase() || nonASCIISingleCaseWordChar.test(ch));
  };
  function isWordChar(ch, helper) {
    if (!helper) return isWordCharBasic(ch);
    if (helper.source.indexOf("\\w") > -1 && isWordCharBasic(ch)) return true;
    return helper.test(ch);
  }

  function isEmpty(obj) {
    for (var n in obj) if (obj.hasOwnProperty(n) && obj[n]) return false;
    return true;
  }

  // Extending unicode characters. A series of a non-extending char +
  // any number of extending chars is treated as a single unit as far
  // as editing and measuring is concerned. This is not fully correct,
  // since some scripts/fonts/browsers also treat other configurations
  // of code points as a group.
  var extendingChars = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065e\u0670\u06d6-\u06dc\u06de-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0900-\u0902\u093c\u0941-\u0948\u094d\u0951-\u0955\u0962\u0963\u0981\u09bc\u09be\u09c1-\u09c4\u09cd\u09d7\u09e2\u09e3\u0a01\u0a02\u0a3c\u0a41\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a70\u0a71\u0a75\u0a81\u0a82\u0abc\u0ac1-\u0ac5\u0ac7\u0ac8\u0acd\u0ae2\u0ae3\u0b01\u0b3c\u0b3e\u0b3f\u0b41-\u0b44\u0b4d\u0b56\u0b57\u0b62\u0b63\u0b82\u0bbe\u0bc0\u0bcd\u0bd7\u0c3e-\u0c40\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0cbc\u0cbf\u0cc2\u0cc6\u0ccc\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0d3e\u0d41-\u0d44\u0d4d\u0d57\u0d62\u0d63\u0dca\u0dcf\u0dd2-\u0dd4\u0dd6\u0ddf\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb\u0ebc\u0ec8-\u0ecd\u0f18\u0f19\u0f35\u0f37\u0f39\u0f71-\u0f7e\u0f80-\u0f84\u0f86\u0f87\u0f90-\u0f97\u0f99-\u0fbc\u0fc6\u102d-\u1030\u1032-\u1037\u1039\u103a\u103d\u103e\u1058\u1059\u105e-\u1060\u1071-\u1074\u1082\u1085\u1086\u108d\u109d\u135f\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17b7-\u17bd\u17c6\u17c9-\u17d3\u17dd\u180b-\u180d\u18a9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193b\u1a17\u1a18\u1a56\u1a58-\u1a5e\u1a60\u1a62\u1a65-\u1a6c\u1a73-\u1a7c\u1a7f\u1b00-\u1b03\u1b34\u1b36-\u1b3a\u1b3c\u1b42\u1b6b-\u1b73\u1b80\u1b81\u1ba2-\u1ba5\u1ba8\u1ba9\u1c2c-\u1c33\u1c36\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1dc0-\u1de6\u1dfd-\u1dff\u200c\u200d\u20d0-\u20f0\u2cef-\u2cf1\u2de0-\u2dff\u302a-\u302f\u3099\u309a\ua66f-\ua672\ua67c\ua67d\ua6f0\ua6f1\ua802\ua806\ua80b\ua825\ua826\ua8c4\ua8e0-\ua8f1\ua926-\ua92d\ua947-\ua951\ua980-\ua982\ua9b3\ua9b6-\ua9b9\ua9bc\uaa29-\uaa2e\uaa31\uaa32\uaa35\uaa36\uaa43\uaa4c\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uabe5\uabe8\uabed\udc00-\udfff\ufb1e\ufe00-\ufe0f\ufe20-\ufe26\uff9e\uff9f]/;
  function isExtendingChar(ch) { return ch.charCodeAt(0) >= 768 && extendingChars.test(ch); }

  // DOM UTILITIES

  function elt(tag, content, className, style) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (style) e.style.cssText = style;
    if (typeof content == "string") e.appendChild(document.createTextNode(content));
    else if (content) for (var i = 0; i < content.length; ++i) e.appendChild(content[i]);
    return e;
  }

  var range;
  if (document.createRange) range = function(node, start, end) {
    var r = document.createRange();
    r.setEnd(node, end);
    r.setStart(node, start);
    return r;
  };
  else range = function(node, start, end) {
    var r = document.body.createTextRange();
    r.moveToElementText(node.parentNode);
    r.collapse(true);
    r.moveEnd("character", end);
    r.moveStart("character", start);
    return r;
  };

  function removeChildren(e) {
    for (var count = e.childNodes.length; count > 0; --count)
      e.removeChild(e.firstChild);
    return e;
  }

  function removeChildrenAndAdd(parent, e) {
    return removeChildren(parent).appendChild(e);
  }

  function contains(parent, child) {
    if (parent.contains)
      return parent.contains(child);
    while (child = child.parentNode)
      if (child == parent) return true;
  }

  function activeElt() { return document.activeElement; }
  // Older versions of IE throws unspecified error when touching
  // document.activeElement in some cases (during loading, in iframe)
  if (ie && ie_version < 11) activeElt = function() {
    try { return document.activeElement; }
    catch(e) { return document.body; }
  };

  function classTest(cls) { return new RegExp("\\b" + cls + "\\b\\s*"); }
  function rmClass(node, cls) {
    var test = classTest(cls);
    if (test.test(node.className)) node.className = node.className.replace(test, "");
  }
  function addClass(node, cls) {
    if (!classTest(cls).test(node.className)) node.className += " " + cls;
  }
  function joinClasses(a, b) {
    var as = a.split(" ");
    for (var i = 0; i < as.length; i++)
      if (as[i] && !classTest(as[i]).test(b)) b += " " + as[i];
    return b;
  }

  // WINDOW-WIDE EVENTS

  // These must be handled carefully, because naively registering a
  // handler for each editor will cause the editors to never be
  // garbage collected.

  function forEachCodeMirror(f) {
    if (!document.body.getElementsByClassName) return;
    var byClass = document.body.getElementsByClassName("CodeMirror");
    for (var i = 0; i < byClass.length; i++) {
      var cm = byClass[i].CodeMirror;
      if (cm) f(cm);
    }
  }

  var globalsRegistered = false;
  function ensureGlobalHandlers() {
    if (globalsRegistered) return;
    registerGlobalHandlers();
    globalsRegistered = true;
  }
  function registerGlobalHandlers() {
    // When the window resizes, we need to refresh active editors.
    var resizeTimer;
    on(window, "resize", function() {
      if (resizeTimer == null) resizeTimer = setTimeout(function() {
        resizeTimer = null;
        knownScrollbarWidth = null;
        forEachCodeMirror(onResize);
      }, 100);
    });
    // When the window loses focus, we want to show the editor as blurred
    on(window, "blur", function() {
      forEachCodeMirror(onBlur);
    });
  }

  // FEATURE DETECTION

  // Detect drag-and-drop
  var dragAndDrop = function() {
    // There is *some* kind of drag-and-drop support in IE6-8, but I
    // couldn't get it to work yet.
    if (ie && ie_version < 9) return false;
    var div = elt('div');
    return "draggable" in div || "dragDrop" in div;
  }();

  var knownScrollbarWidth;
  function scrollbarWidth(measure) {
    if (knownScrollbarWidth != null) return knownScrollbarWidth;
    var test = elt("div", null, null, "width: 50px; height: 50px; overflow-x: scroll");
    removeChildrenAndAdd(measure, test);
    if (test.offsetWidth)
      knownScrollbarWidth = test.offsetHeight - test.clientHeight;
    return knownScrollbarWidth || 0;
  }

  var zwspSupported;
  function zeroWidthElement(measure) {
    if (zwspSupported == null) {
      var test = elt("span", "\u200b");
      removeChildrenAndAdd(measure, elt("span", [test, document.createTextNode("x")]));
      if (measure.firstChild.offsetHeight != 0)
        zwspSupported = test.offsetWidth <= 1 && test.offsetHeight > 2 && !(ie && ie_version < 8);
    }
    if (zwspSupported) return elt("span", "\u200b");
    else return elt("span", "\u00a0", null, "display: inline-block; width: 1px; margin-right: -1px");
  }

  // Feature-detect IE's crummy client rect reporting for bidi text
  var badBidiRects;
  function hasBadBidiRects(measure) {
    if (badBidiRects != null) return badBidiRects;
    var txt = removeChildrenAndAdd(measure, document.createTextNode("A\u062eA"));
    var r0 = range(txt, 0, 1).getBoundingClientRect();
    if (r0.left == r0.right) return false;
    var r1 = range(txt, 1, 2).getBoundingClientRect();
    return badBidiRects = (r1.right - r0.right < 3);
  }

  // See if "".split is the broken IE version, if so, provide an
  // alternative way to split lines.
  var splitLines = CodeMirror.splitLines = "\n\nb".split(/\n/).length != 3 ? function(string) {
    var pos = 0, result = [], l = string.length;
    while (pos <= l) {
      var nl = string.indexOf("\n", pos);
      if (nl == -1) nl = string.length;
      var line = string.slice(pos, string.charAt(nl - 1) == "\r" ? nl - 1 : nl);
      var rt = line.indexOf("\r");
      if (rt != -1) {
        result.push(line.slice(0, rt));
        pos += rt + 1;
      } else {
        result.push(line);
        pos = nl + 1;
      }
    }
    return result;
  } : function(string){return string.split(/\r\n?|\n/);};

  var hasSelection = window.getSelection ? function(te) {
    try { return te.selectionStart != te.selectionEnd; }
    catch(e) { return false; }
  } : function(te) {
    try {var range = te.ownerDocument.selection.createRange();}
    catch(e) {}
    if (!range || range.parentElement() != te) return false;
    return range.compareEndPoints("StartToEnd", range) != 0;
  };

  var hasCopyEvent = (function() {
    var e = elt("div");
    if ("oncopy" in e) return true;
    e.setAttribute("oncopy", "return;");
    return typeof e.oncopy == "function";
  })();

  // KEY NAMES

  var keyNames = {3: "Enter", 8: "Backspace", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt",
                  19: "Pause", 20: "CapsLock", 27: "Esc", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End",
                  36: "Home", 37: "Left", 38: "Up", 39: "Right", 40: "Down", 44: "PrintScrn", 45: "Insert",
                  46: "Delete", 59: ";", 61: "=", 91: "Mod", 92: "Mod", 93: "Mod", 107: "=", 109: "-", 127: "Delete",
                  173: "-", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\",
                  221: "]", 222: "'", 63232: "Up", 63233: "Down", 63234: "Left", 63235: "Right", 63272: "Delete",
                  63273: "Home", 63275: "End", 63276: "PageUp", 63277: "PageDown", 63302: "Insert"};
  CodeMirror.keyNames = keyNames;
  (function() {
    // Number keys
    for (var i = 0; i < 10; i++) keyNames[i + 48] = keyNames[i + 96] = String(i);
    // Alphabetic keys
    for (var i = 65; i <= 90; i++) keyNames[i] = String.fromCharCode(i);
    // Function keys
    for (var i = 1; i <= 12; i++) keyNames[i + 111] = keyNames[i + 63235] = "F" + i;
  })();

  // BIDI HELPERS

  function iterateBidiSections(order, from, to, f) {
    if (!order) return f(from, to, "ltr");
    var found = false;
    for (var i = 0; i < order.length; ++i) {
      var part = order[i];
      if (part.from < to && part.to > from || from == to && part.to == from) {
        f(Math.max(part.from, from), Math.min(part.to, to), part.level == 1 ? "rtl" : "ltr");
        found = true;
      }
    }
    if (!found) f(from, to, "ltr");
  }

  function bidiLeft(part) { return part.level % 2 ? part.to : part.from; }
  function bidiRight(part) { return part.level % 2 ? part.from : part.to; }

  function lineLeft(line) { var order = getOrder(line); return order ? bidiLeft(order[0]) : 0; }
  function lineRight(line) {
    var order = getOrder(line);
    if (!order) return line.text.length;
    return bidiRight(lst(order));
  }

  function lineStart(cm, lineN) {
    var line = getLine(cm.doc, lineN);
    var visual = visualLine(line);
    if (visual != line) lineN = lineNo(visual);
    var order = getOrder(visual);
    var ch = !order ? 0 : order[0].level % 2 ? lineRight(visual) : lineLeft(visual);
    return Pos(lineN, ch);
  }
  function lineEnd(cm, lineN) {
    var merged, line = getLine(cm.doc, lineN);
    while (merged = collapsedSpanAtEnd(line)) {
      line = merged.find(1, true).line;
      lineN = null;
    }
    var order = getOrder(line);
    var ch = !order ? line.text.length : order[0].level % 2 ? lineLeft(line) : lineRight(line);
    return Pos(lineN == null ? lineNo(line) : lineN, ch);
  }

  function compareBidiLevel(order, a, b) {
    var linedir = order[0].level;
    if (a == linedir) return true;
    if (b == linedir) return false;
    return a < b;
  }
  var bidiOther;
  function getBidiPartAt(order, pos) {
    bidiOther = null;
    for (var i = 0, found; i < order.length; ++i) {
      var cur = order[i];
      if (cur.from < pos && cur.to > pos) return i;
      if ((cur.from == pos || cur.to == pos)) {
        if (found == null) {
          found = i;
        } else if (compareBidiLevel(order, cur.level, order[found].level)) {
          if (cur.from != cur.to) bidiOther = found;
          return i;
        } else {
          if (cur.from != cur.to) bidiOther = i;
          return found;
        }
      }
    }
    return found;
  }

  function moveInLine(line, pos, dir, byUnit) {
    if (!byUnit) return pos + dir;
    do pos += dir;
    while (pos > 0 && isExtendingChar(line.text.charAt(pos)));
    return pos;
  }

  // This is needed in order to move 'visually' through bi-directional
  // text -- i.e., pressing left should make the cursor go left, even
  // when in RTL text. The tricky part is the 'jumps', where RTL and
  // LTR text touch each other. This often requires the cursor offset
  // to move more than one unit, in order to visually move one unit.
  function moveVisually(line, start, dir, byUnit) {
    var bidi = getOrder(line);
    if (!bidi) return moveLogically(line, start, dir, byUnit);
    var pos = getBidiPartAt(bidi, start), part = bidi[pos];
    var target = moveInLine(line, start, part.level % 2 ? -dir : dir, byUnit);

    for (;;) {
      if (target > part.from && target < part.to) return target;
      if (target == part.from || target == part.to) {
        if (getBidiPartAt(bidi, target) == pos) return target;
        part = bidi[pos += dir];
        return (dir > 0) == part.level % 2 ? part.to : part.from;
      } else {
        part = bidi[pos += dir];
        if (!part) return null;
        if ((dir > 0) == part.level % 2)
          target = moveInLine(line, part.to, -1, byUnit);
        else
          target = moveInLine(line, part.from, 1, byUnit);
      }
    }
  }

  function moveLogically(line, start, dir, byUnit) {
    var target = start + dir;
    if (byUnit) while (target > 0 && isExtendingChar(line.text.charAt(target))) target += dir;
    return target < 0 || target > line.text.length ? null : target;
  }

  // Bidirectional ordering algorithm
  // See http://unicode.org/reports/tr9/tr9-13.html for the algorithm
  // that this (partially) implements.

  // One-char codes used for character types:
  // L (L):   Left-to-Right
  // R (R):   Right-to-Left
  // r (AL):  Right-to-Left Arabic
  // 1 (EN):  European Number
  // + (ES):  European Number Separator
  // % (ET):  European Number Terminator
  // n (AN):  Arabic Number
  // , (CS):  Common Number Separator
  // m (NSM): Non-Spacing Mark
  // b (BN):  Boundary Neutral
  // s (B):   Paragraph Separator
  // t (S):   Segment Separator
  // w (WS):  Whitespace
  // N (ON):  Other Neutrals

  // Returns null if characters are ordered as they appear
  // (left-to-right), or an array of sections ({from, to, level}
  // objects) in the order in which they occur visually.
  var bidiOrdering = (function() {
    // Character types for codepoints 0 to 0xff
    var lowTypes = "bbbbbbbbbtstwsbbbbbbbbbbbbbbssstwNN%%%NNNNNN,N,N1111111111NNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNbbbbbbsbbbbbbbbbbbbbbbbbbbbbbbbbb,N%%%%NNNNLNNNNN%%11NLNNN1LNNNNNLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLN";
    // Character types for codepoints 0x600 to 0x6ff
    var arabicTypes = "rrrrrrrrrrrr,rNNmmmmmmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmrrrrrrrnnnnnnnnnn%nnrrrmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmmmmmmNmmmm";
    function charType(code) {
      if (code <= 0xf7) return lowTypes.charAt(code);
      else if (0x590 <= code && code <= 0x5f4) return "R";
      else if (0x600 <= code && code <= 0x6ed) return arabicTypes.charAt(code - 0x600);
      else if (0x6ee <= code && code <= 0x8ac) return "r";
      else if (0x2000 <= code && code <= 0x200b) return "w";
      else if (code == 0x200c) return "b";
      else return "L";
    }

    var bidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/;
    var isNeutral = /[stwN]/, isStrong = /[LRr]/, countsAsLeft = /[Lb1n]/, countsAsNum = /[1n]/;
    // Browsers seem to always treat the boundaries of block elements as being L.
    var outerType = "L";

    function BidiSpan(level, from, to) {
      this.level = level;
      this.from = from; this.to = to;
    }

    return function(str) {
      if (!bidiRE.test(str)) return false;
      var len = str.length, types = [];
      for (var i = 0, type; i < len; ++i)
        types.push(type = charType(str.charCodeAt(i)));

      // W1. Examine each non-spacing mark (NSM) in the level run, and
      // change the type of the NSM to the type of the previous
      // character. If the NSM is at the start of the level run, it will
      // get the type of sor.
      for (var i = 0, prev = outerType; i < len; ++i) {
        var type = types[i];
        if (type == "m") types[i] = prev;
        else prev = type;
      }

      // W2. Search backwards from each instance of a European number
      // until the first strong type (R, L, AL, or sor) is found. If an
      // AL is found, change the type of the European number to Arabic
      // number.
      // W3. Change all ALs to R.
      for (var i = 0, cur = outerType; i < len; ++i) {
        var type = types[i];
        if (type == "1" && cur == "r") types[i] = "n";
        else if (isStrong.test(type)) { cur = type; if (type == "r") types[i] = "R"; }
      }

      // W4. A single European separator between two European numbers
      // changes to a European number. A single common separator between
      // two numbers of the same type changes to that type.
      for (var i = 1, prev = types[0]; i < len - 1; ++i) {
        var type = types[i];
        if (type == "+" && prev == "1" && types[i+1] == "1") types[i] = "1";
        else if (type == "," && prev == types[i+1] &&
                 (prev == "1" || prev == "n")) types[i] = prev;
        prev = type;
      }

      // W5. A sequence of European terminators adjacent to European
      // numbers changes to all European numbers.
      // W6. Otherwise, separators and terminators change to Other
      // Neutral.
      for (var i = 0; i < len; ++i) {
        var type = types[i];
        if (type == ",") types[i] = "N";
        else if (type == "%") {
          for (var end = i + 1; end < len && types[end] == "%"; ++end) {}
          var replace = (i && types[i-1] == "!") || (end < len && types[end] == "1") ? "1" : "N";
          for (var j = i; j < end; ++j) types[j] = replace;
          i = end - 1;
        }
      }

      // W7. Search backwards from each instance of a European number
      // until the first strong type (R, L, or sor) is found. If an L is
      // found, then change the type of the European number to L.
      for (var i = 0, cur = outerType; i < len; ++i) {
        var type = types[i];
        if (cur == "L" && type == "1") types[i] = "L";
        else if (isStrong.test(type)) cur = type;
      }

      // N1. A sequence of neutrals takes the direction of the
      // surrounding strong text if the text on both sides has the same
      // direction. European and Arabic numbers act as if they were R in
      // terms of their influence on neutrals. Start-of-level-run (sor)
      // and end-of-level-run (eor) are used at level run boundaries.
      // N2. Any remaining neutrals take the embedding direction.
      for (var i = 0; i < len; ++i) {
        if (isNeutral.test(types[i])) {
          for (var end = i + 1; end < len && isNeutral.test(types[end]); ++end) {}
          var before = (i ? types[i-1] : outerType) == "L";
          var after = (end < len ? types[end] : outerType) == "L";
          var replace = before || after ? "L" : "R";
          for (var j = i; j < end; ++j) types[j] = replace;
          i = end - 1;
        }
      }

      // Here we depart from the documented algorithm, in order to avoid
      // building up an actual levels array. Since there are only three
      // levels (0, 1, 2) in an implementation that doesn't take
      // explicit embedding into account, we can build up the order on
      // the fly, without following the level-based algorithm.
      var order = [], m;
      for (var i = 0; i < len;) {
        if (countsAsLeft.test(types[i])) {
          var start = i;
          for (++i; i < len && countsAsLeft.test(types[i]); ++i) {}
          order.push(new BidiSpan(0, start, i));
        } else {
          var pos = i, at = order.length;
          for (++i; i < len && types[i] != "L"; ++i) {}
          for (var j = pos; j < i;) {
            if (countsAsNum.test(types[j])) {
              if (pos < j) order.splice(at, 0, new BidiSpan(1, pos, j));
              var nstart = j;
              for (++j; j < i && countsAsNum.test(types[j]); ++j) {}
              order.splice(at, 0, new BidiSpan(2, nstart, j));
              pos = j;
            } else ++j;
          }
          if (pos < i) order.splice(at, 0, new BidiSpan(1, pos, i));
        }
      }
      if (order[0].level == 1 && (m = str.match(/^\s+/))) {
        order[0].from = m[0].length;
        order.unshift(new BidiSpan(0, 0, m[0].length));
      }
      if (lst(order).level == 1 && (m = str.match(/\s+$/))) {
        lst(order).to -= m[0].length;
        order.push(new BidiSpan(0, len - m[0].length, len));
      }
      if (order[0].level != lst(order).level)
        order.push(new BidiSpan(order[0].level, len, len));

      return order;
    };
  })();

  // THE END

  CodeMirror.version = "4.3.0";

  return CodeMirror;
});


// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

// A rough approximation of Sublime Text's keybindings
// Depends on addon/search/searchcursor.js and optionally addon/dialog/dialogs.js

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../lib/codemirror"), require("../addon/search/searchcursor"), require("../addon/edit/matchbrackets"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../lib/codemirror", "../addon/search/searchcursor", "../addon/edit/matchbrackets"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  var map = CodeMirror.keyMap.sublime = {fallthrough: "default"};
  var cmds = CodeMirror.commands;
  var Pos = CodeMirror.Pos;
  var ctrl = CodeMirror.keyMap["default"] == CodeMirror.keyMap.pcDefault ? "Ctrl-" : "Cmd-";

  // This is not exactly Sublime's algorithm. I couldn't make heads or tails of that.
  function findPosSubword(doc, start, dir) {
    if (dir < 0 && start.ch == 0) return doc.clipPos(Pos(start.line - 1));
    var line = doc.getLine(start.line);
    if (dir > 0 && start.ch >= line.length) return doc.clipPos(Pos(start.line + 1, 0));
    var state = "start", type;
    for (var pos = start.ch, e = dir < 0 ? 0 : line.length, i = 0; pos != e; pos += dir, i++) {
      var next = line.charAt(dir < 0 ? pos - 1 : pos);
      var cat = next != "_" && CodeMirror.isWordChar(next) ? "w" : "o";
      if (cat == "w" && next.toUpperCase() == next) cat = "W";
      if (state == "start") {
        if (cat != "o") { state = "in"; type = cat; }
      } else if (state == "in") {
        if (type != cat) {
          if (type == "w" && cat == "W" && dir < 0) pos--;
          if (type == "W" && cat == "w" && dir > 0) { type = "w"; continue; }
          break;
        }
      }
    }
    return Pos(start.line, pos);
  }

  function moveSubword(cm, dir) {
    cm.extendSelectionsBy(function(range) {
      if (cm.display.shift || cm.doc.extend || range.empty())
        return findPosSubword(cm.doc, range.head, dir);
      else
        return dir < 0 ? range.from() : range.to();
    });
  }

  cmds[map["Alt-Left"] = "goSubwordLeft"] = function(cm) { moveSubword(cm, -1); };
  cmds[map["Alt-Right"] = "goSubwordRight"] = function(cm) { moveSubword(cm, 1); };

  cmds[map[ctrl + "Up"] = "scrollLineUp"] = function(cm) {
    var info = cm.getScrollInfo();
    if (!cm.somethingSelected()) {
      var visibleBottomLine = cm.lineAtHeight(info.top + info.clientHeight, "local");
      if (cm.getCursor().line >= visibleBottomLine)
        cm.execCommand("goLineUp");
    }
    cm.scrollTo(null, info.top - cm.defaultTextHeight());
  };
  cmds[map[ctrl + "Down"] = "scrollLineDown"] = function(cm) {
    var info = cm.getScrollInfo();
    if (!cm.somethingSelected()) {
      var visibleTopLine = cm.lineAtHeight(info.top, "local")+1;
      if (cm.getCursor().line <= visibleTopLine)
        cm.execCommand("goLineDown");
    }
    cm.scrollTo(null, info.top + cm.defaultTextHeight());
  };

  cmds[map["Shift-" + ctrl + "L"] = "splitSelectionByLine"] = function(cm) {
    var ranges = cm.listSelections(), lineRanges = [];
    for (var i = 0; i < ranges.length; i++) {
      var from = ranges[i].from(), to = ranges[i].to();
      for (var line = from.line; line <= to.line; ++line)
        if (!(to.line > from.line && line == to.line && to.ch == 0))
          lineRanges.push({anchor: line == from.line ? from : Pos(line, 0),
                           head: line == to.line ? to : Pos(line)});
    }
    cm.setSelections(lineRanges, 0);
  };

  map["Shift-Tab"] = "indentLess";

  cmds[map["Esc"] = "singleSelectionTop"] = function(cm) {
    var range = cm.listSelections()[0];
    cm.setSelection(range.anchor, range.head, {scroll: false});
  };

  cmds[map[ctrl + "L"] = "selectLine"] = function(cm) {
    var ranges = cm.listSelections(), extended = [];
    for (var i = 0; i < ranges.length; i++) {
      var range = ranges[i];
      extended.push({anchor: Pos(range.from().line, 0),
                     head: Pos(range.to().line + 1, 0)});
    }
    cm.setSelections(extended);
  };

  map["Shift-" + ctrl + "K"] = "deleteLine";

  function insertLine(cm, above) {
    cm.operation(function() {
      var len = cm.listSelections().length, newSelection = [], last = -1;
      for (var i = 0; i < len; i++) {
        var head = cm.listSelections()[i].head;
        if (head.line <= last) continue;
        var at = Pos(head.line + (above ? 0 : 1), 0);
        cm.replaceRange("\n", at, null, "+insertLine");
        cm.indentLine(at.line, null, true);
        newSelection.push({head: at, anchor: at});
        last = head.line + 1;
      }
      cm.setSelections(newSelection);
    });
  }

  cmds[map[ctrl + "Enter"] = "insertLineAfter"] = function(cm) { insertLine(cm, false); };

  cmds[map["Shift-" + ctrl + "Enter"] = "insertLineBefore"] = function(cm) { insertLine(cm, true); };

  function wordAt(cm, pos) {
    var start = pos.ch, end = start, line = cm.getLine(pos.line);
    while (start && CodeMirror.isWordChar(line.charAt(start - 1))) --start;
    while (end < line.length && CodeMirror.isWordChar(line.charAt(end))) ++end;
    return {from: Pos(pos.line, start), to: Pos(pos.line, end), word: line.slice(start, end)};
  }

  cmds[map[ctrl + "D"] = "selectNextOccurrence"] = function(cm) {
    var from = cm.getCursor("from"), to = cm.getCursor("to");
    var fullWord = cm.state.sublimeFindFullWord == cm.doc.sel;
    if (CodeMirror.cmpPos(from, to) == 0) {
      var word = wordAt(cm, from);
      if (!word.word) return;
      cm.setSelection(word.from, word.to);
      fullWord = true;
    } else {
      var text = cm.getRange(from, to);
      var query = fullWord ? new RegExp("\\b" + text + "\\b") : text;
      var cur = cm.getSearchCursor(query, to);
      if (cur.findNext()) {
        cm.addSelection(cur.from(), cur.to());
      } else {
        cur = cm.getSearchCursor(query, Pos(cm.firstLine(), 0));
        if (cur.findNext())
          cm.addSelection(cur.from(), cur.to());
      }
    }
    if (fullWord)
      cm.state.sublimeFindFullWord = cm.doc.sel;
  };

  var mirror = "(){}[]";
  function selectBetweenBrackets(cm) {
    var pos = cm.getCursor(), opening = cm.scanForBracket(pos, -1);
    if (!opening) return;
    for (;;) {
      var closing = cm.scanForBracket(pos, 1);
      if (!closing) return;
      if (closing.ch == mirror.charAt(mirror.indexOf(opening.ch) + 1)) {
        cm.setSelection(Pos(opening.pos.line, opening.pos.ch + 1), closing.pos, false);
        return true;
      }
      pos = Pos(closing.pos.line, closing.pos.ch + 1);
    }
  }

  cmds[map["Shift-" + ctrl + "Space"] = "selectScope"] = function(cm) {
    selectBetweenBrackets(cm) || cm.execCommand("selectAll");
  };
  cmds[map["Shift-" + ctrl + "M"] = "selectBetweenBrackets"] = function(cm) {
    if (!selectBetweenBrackets(cm)) return CodeMirror.Pass;
  };

  cmds[map[ctrl + "M"] = "goToBracket"] = function(cm) {
    cm.extendSelectionsBy(function(range) {
      var next = cm.scanForBracket(range.head, 1);
      if (next && CodeMirror.cmpPos(next.pos, range.head) != 0) return next.pos;
      var prev = cm.scanForBracket(range.head, -1);
      return prev && Pos(prev.pos.line, prev.pos.ch + 1) || range.head;
    });
  };

  cmds[map["Shift-" + ctrl + "Up"] = "swapLineUp"] = function(cm) {
    var ranges = cm.listSelections(), linesToMove = [], at = cm.firstLine() - 1, newSels = [];
    for (var i = 0; i < ranges.length; i++) {
      var range = ranges[i], from = range.from().line - 1, to = range.to().line;
      newSels.push({anchor: Pos(range.anchor.line - 1, range.anchor.ch),
                    head: Pos(range.head.line - 1, range.head.ch)});
      if (range.to().ch == 0 && !range.empty()) --to;
      if (from > at) linesToMove.push(from, to);
      else if (linesToMove.length) linesToMove[linesToMove.length - 1] = to;
      at = to;
    }
    cm.operation(function() {
      for (var i = 0; i < linesToMove.length; i += 2) {
        var from = linesToMove[i], to = linesToMove[i + 1];
        var line = cm.getLine(from);
        cm.replaceRange("", Pos(from, 0), Pos(from + 1, 0), "+swapLine");
        if (to > cm.lastLine())
          cm.replaceRange("\n" + line, Pos(cm.lastLine()), null, "+swapLine");
        else
          cm.replaceRange(line + "\n", Pos(to, 0), null, "+swapLine");
      }
      cm.setSelections(newSels);
      cm.scrollIntoView();
    });
  };

  cmds[map["Shift-" + ctrl + "Down"] = "swapLineDown"] = function(cm) {
    var ranges = cm.listSelections(), linesToMove = [], at = cm.lastLine() + 1;
    for (var i = ranges.length - 1; i >= 0; i--) {
      var range = ranges[i], from = range.to().line + 1, to = range.from().line;
      if (range.to().ch == 0 && !range.empty()) from--;
      if (from < at) linesToMove.push(from, to);
      else if (linesToMove.length) linesToMove[linesToMove.length - 1] = to;
      at = to;
    }
    cm.operation(function() {
      for (var i = linesToMove.length - 2; i >= 0; i -= 2) {
        var from = linesToMove[i], to = linesToMove[i + 1];
        var line = cm.getLine(from);
        if (from == cm.lastLine())
          cm.replaceRange("", Pos(from - 1), Pos(from), "+swapLine");
        else
          cm.replaceRange("", Pos(from, 0), Pos(from + 1, 0), "+swapLine");
        cm.replaceRange(line + "\n", Pos(to, 0), null, "+swapLine");
      }
      cm.scrollIntoView();
    });
  };

  map[ctrl + "/"] = "toggleComment";

  cmds[map[ctrl + "J"] = "joinLines"] = function(cm) {
    var ranges = cm.listSelections(), joined = [];
    for (var i = 0; i < ranges.length; i++) {
      var range = ranges[i], from = range.from();
      var start = from.line, end = range.to().line;
      while (i < ranges.length - 1 && ranges[i + 1].from().line == end)
        end = ranges[++i].to().line;
      joined.push({start: start, end: end, anchor: !range.empty() && from});
    }
    cm.operation(function() {
      var offset = 0, ranges = [];
      for (var i = 0; i < joined.length; i++) {
        var obj = joined[i];
        var anchor = obj.anchor && Pos(obj.anchor.line - offset, obj.anchor.ch), head;
        for (var line = obj.start; line <= obj.end; line++) {
          var actual = line - offset;
          if (line == obj.end) head = Pos(actual, cm.getLine(actual).length + 1);
          if (actual < cm.lastLine()) {
            cm.replaceRange(" ", Pos(actual), Pos(actual + 1, /^\s*/.exec(cm.getLine(actual + 1))[0].length));
            ++offset;
          }
        }
        ranges.push({anchor: anchor || head, head: head});
      }
      cm.setSelections(ranges, 0);
    });
  };

  cmds[map["Shift-" + ctrl + "D"] = "duplicateLine"] = function(cm) {
    cm.operation(function() {
      var rangeCount = cm.listSelections().length;
      for (var i = 0; i < rangeCount; i++) {
        var range = cm.listSelections()[i];
        if (range.empty())
          cm.replaceRange(cm.getLine(range.head.line) + "\n", Pos(range.head.line, 0));
        else
          cm.replaceRange(cm.getRange(range.from(), range.to()), range.from());
      }
      cm.scrollIntoView();
    });
  };

  map[ctrl + "T"] = "transposeChars";

  function sortLines(cm, caseSensitive) {
    var ranges = cm.listSelections(), toSort = [], selected;
    for (var i = 0; i < ranges.length; i++) {
      var range = ranges[i];
      if (range.empty()) continue;
      var from = range.from().line, to = range.to().line;
      while (i < ranges.length - 1 && ranges[i + 1].from().line == to)
        to = range[++i].to().line;
      toSort.push(from, to);
    }
    if (toSort.length) selected = true;
    else toSort.push(cm.firstLine(), cm.lastLine());

    cm.operation(function() {
      var ranges = [];
      for (var i = 0; i < toSort.length; i += 2) {
        var from = toSort[i], to = toSort[i + 1];
        var start = Pos(from, 0), end = Pos(to);
        var lines = cm.getRange(start, end, false);
        if (caseSensitive)
          lines.sort();
        else
          lines.sort(function(a, b) {
            var au = a.toUpperCase(), bu = b.toUpperCase();
            if (au != bu) { a = au; b = bu; }
            return a < b ? -1 : a == b ? 0 : 1;
          });
        cm.replaceRange(lines, start, end);
        if (selected) ranges.push({anchor: start, head: end});
      }
      if (selected) cm.setSelections(ranges, 0);
    });
  }

  cmds[map["F9"] = "sortLines"] = function(cm) { sortLines(cm, true); };
  cmds[map[ctrl + "F9"] = "sortLinesInsensitive"] = function(cm) { sortLines(cm, false); };

  cmds[map["F2"] = "nextBookmark"] = function(cm) {
    var marks = cm.state.sublimeBookmarks;
    if (marks) while (marks.length) {
      var current = marks.shift();
      var found = current.find();
      if (found) {
        marks.push(current);
        return cm.setSelection(found.from, found.to);
      }
    }
  };

  cmds[map["Shift-F2"] = "prevBookmark"] = function(cm) {
    var marks = cm.state.sublimeBookmarks;
    if (marks) while (marks.length) {
      marks.unshift(marks.pop());
      var found = marks[marks.length - 1].find();
      if (!found)
        marks.pop();
      else
        return cm.setSelection(found.from, found.to);
    }
  };

  cmds[map[ctrl + "F2"] = "toggleBookmark"] = function(cm) {
    var ranges = cm.listSelections();
    var marks = cm.state.sublimeBookmarks || (cm.state.sublimeBookmarks = []);
    for (var i = 0; i < ranges.length; i++) {
      var from = ranges[i].from(), to = ranges[i].to();
      var found = cm.findMarks(from, to);
      for (var j = 0; j < found.length; j++) {
        if (found[j].sublimeBookmark) {
          found[j].clear();
          for (var k = 0; k < marks.length; k++)
            if (marks[k] == found[j])
              marks.splice(k--, 1);
          break;
        }
      }
      if (j == found.length)
        marks.push(cm.markText(from, to, {sublimeBookmark: true, clearWhenEmpty: false}));
    }
  };

  cmds[map["Shift-" + ctrl + "F2"] = "clearBookmarks"] = function(cm) {
    var marks = cm.state.sublimeBookmarks;
    if (marks) for (var i = 0; i < marks.length; i++) marks[i].clear();
    marks.length = 0;
  };

  cmds[map["Alt-F2"] = "selectBookmarks"] = function(cm) {
    var marks = cm.state.sublimeBookmarks, ranges = [];
    if (marks) for (var i = 0; i < marks.length; i++) {
      var found = marks[i].find();
      if (!found)
        marks.splice(i--, 0);
      else
        ranges.push({anchor: found.from, head: found.to});
    }
    if (ranges.length)
      cm.setSelections(ranges, 0);
  };

  map["Alt-Q"] = "wrapLines";

  var mapK = CodeMirror.keyMap["sublime-Ctrl-K"] = {auto: "sublime", nofallthrough: true};

  map[ctrl + "K"] = function(cm) {cm.setOption("keyMap", "sublime-Ctrl-K");};

  function modifyWordOrSelection(cm, mod) {
    cm.operation(function() {
      var ranges = cm.listSelections(), indices = [], replacements = [];
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (range.empty()) { indices.push(i); replacements.push(""); }
        else replacements.push(mod(cm.getRange(range.from(), range.to())));
      }
      cm.replaceSelections(replacements, "around", "case");
      for (var i = indices.length - 1, at; i >= 0; i--) {
        var range = ranges[indices[i]];
        if (at && CodeMirror.cmpPos(range.head, at) > 0) continue;
        var word = wordAt(cm, range.head);
        at = word.from;
        cm.replaceRange(mod(word.word), word.from, word.to);
      }
    });
  }

  mapK[ctrl + "Backspace"] = "delLineLeft";

  cmds[mapK[ctrl + "K"] = "delLineRight"] = function(cm) {
    cm.operation(function() {
      var ranges = cm.listSelections();
      for (var i = ranges.length - 1; i >= 0; i--)
        cm.replaceRange("", ranges[i].anchor, Pos(ranges[i].to().line), "+delete");
      cm.scrollIntoView();
    });
  };

  cmds[mapK[ctrl + "U"] = "upcaseAtCursor"] = function(cm) {
    modifyWordOrSelection(cm, function(str) { return str.toUpperCase(); });
  };
  cmds[mapK[ctrl + "L"] = "downcaseAtCursor"] = function(cm) {
    modifyWordOrSelection(cm, function(str) { return str.toLowerCase(); });
  };

  cmds[mapK[ctrl + "Space"] = "setSublimeMark"] = function(cm) {
    if (cm.state.sublimeMark) cm.state.sublimeMark.clear();
    cm.state.sublimeMark = cm.setBookmark(cm.getCursor());
  };
  cmds[mapK[ctrl + "A"] = "selectToSublimeMark"] = function(cm) {
    var found = cm.state.sublimeMark && cm.state.sublimeMark.find();
    if (found) cm.setSelection(cm.getCursor(), found);
  };
  cmds[mapK[ctrl + "W"] = "deleteToSublimeMark"] = function(cm) {
    var found = cm.state.sublimeMark && cm.state.sublimeMark.find();
    if (found) {
      var from = cm.getCursor(), to = found;
      if (CodeMirror.cmpPos(from, to) > 0) { var tmp = to; to = from; from = tmp; }
      cm.state.sublimeKilled = cm.getRange(from, to);
      cm.replaceRange("", from, to);
    }
  };
  cmds[mapK[ctrl + "X"] = "swapWithSublimeMark"] = function(cm) {
    var found = cm.state.sublimeMark && cm.state.sublimeMark.find();
    if (found) {
      cm.state.sublimeMark.clear();
      cm.state.sublimeMark = cm.setBookmark(cm.getCursor());
      cm.setCursor(found);
    }
  };
  cmds[mapK[ctrl + "Y"] = "sublimeYank"] = function(cm) {
    if (cm.state.sublimeKilled != null)
      cm.replaceSelection(cm.state.sublimeKilled, null, "paste");
  };

  mapK[ctrl + "G"] = "clearBookmarks";
  cmds[mapK[ctrl + "C"] = "showInCenter"] = function(cm) {
    var pos = cm.cursorCoords(null, "local");
    cm.scrollTo(null, (pos.top + pos.bottom) / 2 - cm.getScrollInfo().clientHeight / 2);
  };

  cmds[map["Shift-Alt-Up"] = "selectLinesUpward"] = function(cm) {
    cm.operation(function() {
      var ranges = cm.listSelections();
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (range.head.line > cm.firstLine())
          cm.addSelection(Pos(range.head.line - 1, range.head.ch));
      }
    });
  };
  cmds[map["Shift-Alt-Down"] = "selectLinesDownward"] = function(cm) {
    cm.operation(function() {
      var ranges = cm.listSelections();
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (range.head.line < cm.lastLine())
          cm.addSelection(Pos(range.head.line + 1, range.head.ch));
      }
    });
  };

  function findAndGoTo(cm, forward) {
    var from = cm.getCursor("from"), to = cm.getCursor("to");
    if (CodeMirror.cmpPos(from, to) == 0) {
      var word = wordAt(cm, from);
      if (!word.word) return;
      from = word.from;
      to = word.to;
    }

    var query = cm.getRange(from, to);
    var cur = cm.getSearchCursor(query, forward ? to : from);

    if (forward ? cur.findNext() : cur.findPrevious()) {
      cm.setSelection(cur.from(), cur.to());
    } else {
      cur = cm.getSearchCursor(query, forward ? Pos(cm.firstLine(), 0)
                                              : cm.clipPos(Pos(cm.lastLine())));
      if (forward ? cur.findNext() : cur.findPrevious())
        cm.setSelection(cur.from(), cur.to());
      else if (word)
        cm.setSelection(from, to);
    }
  };
  cmds[map[ctrl + "F3"] = "findUnder"] = function(cm) { findAndGoTo(cm, true); };
  cmds[map["Shift-" + ctrl + "F3"] = "findUnderPrevious"] = function(cm) { findAndGoTo(cm,false); };

  map["Shift-" + ctrl + "["] = "fold";
  map["Shift-" + ctrl + "]"] = "unfold";
  mapK[ctrl + "0"] = mapK[ctrl + "j"] = "unfoldAll";

  map[ctrl + "I"] = "findIncremental";
  map["Shift-" + ctrl + "I"] = "findIncrementalReverse";
  map[ctrl + "H"] = "replace";
  map["F3"] = "findNext";
  map["Shift-F3"] = "findPrev";

});


// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

// TODO actually recognize syntax of TypeScript constructs

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
"use strict";

CodeMirror.defineMode("javascript", function(config, parserConfig) {
  var indentUnit = config.indentUnit;
  var statementIndent = parserConfig.statementIndent;
  var jsonldMode = parserConfig.jsonld;
  var jsonMode = parserConfig.json || jsonldMode;
  var isTS = parserConfig.typescript;

  // Tokenizer

  var keywords = function(){
    function kw(type) {return {type: type, style: "keyword"};}
    var A = kw("keyword a"), B = kw("keyword b"), C = kw("keyword c");
    var operator = kw("operator"), atom = {type: "atom", style: "atom"};

    var jsKeywords = {
      "if": kw("if"), "while": A, "with": A, "else": B, "do": B, "try": B, "finally": B,
      "return": C, "break": C, "continue": C, "new": C, "delete": C, "throw": C, "debugger": C,
      "var": kw("var"), "const": kw("var"), "let": kw("var"),
      "function": kw("function"), "catch": kw("catch"),
      "for": kw("for"), "switch": kw("switch"), "case": kw("case"), "default": kw("default"),
      "in": operator, "typeof": operator, "instanceof": operator,
      "true": atom, "false": atom, "null": atom, "undefined": atom, "NaN": atom, "Infinity": atom,
      "this": kw("this"), "module": kw("module"), "class": kw("class"), "super": kw("atom"),
      "yield": C, "export": kw("export"), "import": kw("import"), "extends": C
    };

    // Extend the 'normal' keywords with the TypeScript language extensions
    if (isTS) {
      var type = {type: "variable", style: "variable-3"};
      var tsKeywords = {
        // object-like things
        "interface": kw("interface"),
        "extends": kw("extends"),
        "constructor": kw("constructor"),

        // scope modifiers
        "public": kw("public"),
        "private": kw("private"),
        "protected": kw("protected"),
        "static": kw("static"),

        // types
        "string": type, "number": type, "bool": type, "any": type
      };

      for (var attr in tsKeywords) {
        jsKeywords[attr] = tsKeywords[attr];
      }
    }

    return jsKeywords;
  }();

  var isOperatorChar = /[+\-*&%=<>!?|~^]/;
  var isJsonldKeyword = /^@(context|id|value|language|type|container|list|set|reverse|index|base|vocab|graph)"/;

  function readRegexp(stream) {
    var escaped = false, next, inSet = false;
    while ((next = stream.next()) != null) {
      if (!escaped) {
        if (next == "/" && !inSet) return;
        if (next == "[") inSet = true;
        else if (inSet && next == "]") inSet = false;
      }
      escaped = !escaped && next == "\\";
    }
  }

  // Used as scratch variables to communicate multiple values without
  // consing up tons of objects.
  var type, content;
  function ret(tp, style, cont) {
    type = tp; content = cont;
    return style;
  }
  function tokenBase(stream, state) {
    var ch = stream.next();
    if (ch == '"' || ch == "'") {
      state.tokenize = tokenString(ch);
      return state.tokenize(stream, state);
    } else if (ch == "." && stream.match(/^\d+(?:[eE][+\-]?\d+)?/)) {
      return ret("number", "number");
    } else if (ch == "." && stream.match("..")) {
      return ret("spread", "meta");
    } else if (/[\[\]{}\(\),;\:\.]/.test(ch)) {
      return ret(ch);
    } else if (ch == "=" && stream.eat(">")) {
      return ret("=>", "operator");
    } else if (ch == "0" && stream.eat(/x/i)) {
      stream.eatWhile(/[\da-f]/i);
      return ret("number", "number");
    } else if (/\d/.test(ch)) {
      stream.match(/^\d*(?:\.\d*)?(?:[eE][+\-]?\d+)?/);
      return ret("number", "number");
    } else if (ch == "/") {
      if (stream.eat("*")) {
        state.tokenize = tokenComment;
        return tokenComment(stream, state);
      } else if (stream.eat("/")) {
        stream.skipToEnd();
        return ret("comment", "comment");
      } else if (state.lastType == "operator" || state.lastType == "keyword c" ||
               state.lastType == "sof" || /^[\[{}\(,;:]$/.test(state.lastType)) {
        readRegexp(stream);
        stream.eatWhile(/[gimy]/); // 'y' is "sticky" option in Mozilla
        return ret("regexp", "string-2");
      } else {
        stream.eatWhile(isOperatorChar);
        return ret("operator", "operator", stream.current());
      }
    } else if (ch == "`") {
      state.tokenize = tokenQuasi;
      return tokenQuasi(stream, state);
    } else if (ch == "#") {
      stream.skipToEnd();
      return ret("error", "error");
    } else if (isOperatorChar.test(ch)) {
      stream.eatWhile(isOperatorChar);
      return ret("operator", "operator", stream.current());
    } else {
      stream.eatWhile(/[\w\$_]/);
      var word = stream.current(), known = keywords.propertyIsEnumerable(word) && keywords[word];
      return (known && state.lastType != ".") ? ret(known.type, known.style, word) :
                     ret("variable", "variable", word);
    }
  }

  function tokenString(quote) {
    return function(stream, state) {
      var escaped = false, next;
      if (jsonldMode && stream.peek() == "@" && stream.match(isJsonldKeyword)){
        state.tokenize = tokenBase;
        return ret("jsonld-keyword", "meta");
      }
      while ((next = stream.next()) != null) {
        if (next == quote && !escaped) break;
        escaped = !escaped && next == "\\";
      }
      if (!escaped) state.tokenize = tokenBase;
      return ret("string", "string");
    };
  }

  function tokenComment(stream, state) {
    var maybeEnd = false, ch;
    while (ch = stream.next()) {
      if (ch == "/" && maybeEnd) {
        state.tokenize = tokenBase;
        break;
      }
      maybeEnd = (ch == "*");
    }
    return ret("comment", "comment");
  }

  function tokenQuasi(stream, state) {
    var escaped = false, next;
    while ((next = stream.next()) != null) {
      if (!escaped && (next == "`" || next == "$" && stream.eat("{"))) {
        state.tokenize = tokenBase;
        break;
      }
      escaped = !escaped && next == "\\";
    }
    return ret("quasi", "string-2", stream.current());
  }

  var brackets = "([{}])";
  // This is a crude lookahead trick to try and notice that we're
  // parsing the argument patterns for a fat-arrow function before we
  // actually hit the arrow token. It only works if the arrow is on
  // the same line as the arguments and there's no strange noise
  // (comments) in between. Fallback is to only notice when we hit the
  // arrow, and not declare the arguments as locals for the arrow
  // body.
  function findFatArrow(stream, state) {
    if (state.fatArrowAt) state.fatArrowAt = null;
    var arrow = stream.string.indexOf("=>", stream.start);
    if (arrow < 0) return;

    var depth = 0, sawSomething = false;
    for (var pos = arrow - 1; pos >= 0; --pos) {
      var ch = stream.string.charAt(pos);
      var bracket = brackets.indexOf(ch);
      if (bracket >= 0 && bracket < 3) {
        if (!depth) { ++pos; break; }
        if (--depth == 0) break;
      } else if (bracket >= 3 && bracket < 6) {
        ++depth;
      } else if (/[$\w]/.test(ch)) {
        sawSomething = true;
      } else if (sawSomething && !depth) {
        ++pos;
        break;
      }
    }
    if (sawSomething && !depth) state.fatArrowAt = pos;
  }

  // Parser

  var atomicTypes = {"atom": true, "number": true, "variable": true, "string": true, "regexp": true, "this": true, "jsonld-keyword": true};

  function JSLexical(indented, column, type, align, prev, info) {
    this.indented = indented;
    this.column = column;
    this.type = type;
    this.prev = prev;
    this.info = info;
    if (align != null) this.align = align;
  }

  function inScope(state, varname) {
    for (var v = state.localVars; v; v = v.next)
      if (v.name == varname) return true;
    for (var cx = state.context; cx; cx = cx.prev) {
      for (var v = cx.vars; v; v = v.next)
        if (v.name == varname) return true;
    }
  }

  function parseJS(state, style, type, content, stream) {
    var cc = state.cc;
    // Communicate our context to the combinators.
    // (Less wasteful than consing up a hundred closures on every call.)
    cx.state = state; cx.stream = stream; cx.marked = null, cx.cc = cc; cx.style = style;

    if (!state.lexical.hasOwnProperty("align"))
      state.lexical.align = true;

    while(true) {
      var combinator = cc.length ? cc.pop() : jsonMode ? expression : statement;
      if (combinator(type, content)) {
        while(cc.length && cc[cc.length - 1].lex)
          cc.pop()();
        if (cx.marked) return cx.marked;
        if (type == "variable" && inScope(state, content)) return "variable-2";
        return style;
      }
    }
  }

  // Combinator utils

  var cx = {state: null, column: null, marked: null, cc: null};
  function pass() {
    for (var i = arguments.length - 1; i >= 0; i--) cx.cc.push(arguments[i]);
  }
  function cont() {
    pass.apply(null, arguments);
    return true;
  }
  function register(varname) {
    function inList(list) {
      for (var v = list; v; v = v.next)
        if (v.name == varname) return true;
      return false;
    }
    var state = cx.state;
    if (state.context) {
      cx.marked = "def";
      if (inList(state.localVars)) return;
      state.localVars = {name: varname, next: state.localVars};
    } else {
      if (inList(state.globalVars)) return;
      if (parserConfig.globalVars)
        state.globalVars = {name: varname, next: state.globalVars};
    }
  }

  // Combinators

  var defaultVars = {name: "this", next: {name: "arguments"}};
  function pushcontext() {
    cx.state.context = {prev: cx.state.context, vars: cx.state.localVars};
    cx.state.localVars = defaultVars;
  }
  function popcontext() {
    cx.state.localVars = cx.state.context.vars;
    cx.state.context = cx.state.context.prev;
  }
  function pushlex(type, info) {
    var result = function() {
      var state = cx.state, indent = state.indented;
      if (state.lexical.type == "stat") indent = state.lexical.indented;
      state.lexical = new JSLexical(indent, cx.stream.column(), type, null, state.lexical, info);
    };
    result.lex = true;
    return result;
  }
  function poplex() {
    var state = cx.state;
    if (state.lexical.prev) {
      if (state.lexical.type == ")")
        state.indented = state.lexical.indented;
      state.lexical = state.lexical.prev;
    }
  }
  poplex.lex = true;

  function expect(wanted) {
    function exp(type) {
      if (type == wanted) return cont();
      else if (wanted == ";") return pass();
      else return cont(exp);
    };
    return exp;
  }

  function statement(type, value) {
    if (type == "var") return cont(pushlex("vardef", value.length), vardef, expect(";"), poplex);
    if (type == "keyword a") return cont(pushlex("form"), expression, statement, poplex);
    if (type == "keyword b") return cont(pushlex("form"), statement, poplex);
    if (type == "{") return cont(pushlex("}"), block, poplex);
    if (type == ";") return cont();
    if (type == "if") {
      if (cx.state.lexical.info == "else" && cx.state.cc[cx.state.cc.length - 1] == poplex)
        cx.state.cc.pop()();
      return cont(pushlex("form"), expression, statement, poplex, maybeelse);
    }
    if (type == "function") return cont(functiondef);
    if (type == "for") return cont(pushlex("form"), forspec, statement, poplex);
    if (type == "variable") return cont(pushlex("stat"), maybelabel);
    if (type == "switch") return cont(pushlex("form"), expression, pushlex("}", "switch"), expect("{"),
                                      block, poplex, poplex);
    if (type == "case") return cont(expression, expect(":"));
    if (type == "default") return cont(expect(":"));
    if (type == "catch") return cont(pushlex("form"), pushcontext, expect("("), funarg, expect(")"),
                                     statement, poplex, popcontext);
    if (type == "module") return cont(pushlex("form"), pushcontext, afterModule, popcontext, poplex);
    if (type == "class") return cont(pushlex("form"), className, poplex);
    if (type == "export") return cont(pushlex("form"), afterExport, poplex);
    if (type == "import") return cont(pushlex("form"), afterImport, poplex);
    return pass(pushlex("stat"), expression, expect(";"), poplex);
  }
  function expression(type) {
    return expressionInner(type, false);
  }
  function expressionNoComma(type) {
    return expressionInner(type, true);
  }
  function expressionInner(type, noComma) {
    if (cx.state.fatArrowAt == cx.stream.start) {
      var body = noComma ? arrowBodyNoComma : arrowBody;
      if (type == "(") return cont(pushcontext, pushlex(")"), commasep(pattern, ")"), poplex, expect("=>"), body, popcontext);
      else if (type == "variable") return pass(pushcontext, pattern, expect("=>"), body, popcontext);
    }

    var maybeop = noComma ? maybeoperatorNoComma : maybeoperatorComma;
    if (atomicTypes.hasOwnProperty(type)) return cont(maybeop);
    if (type == "function") return cont(functiondef, maybeop);
    if (type == "keyword c") return cont(noComma ? maybeexpressionNoComma : maybeexpression);
    if (type == "(") return cont(pushlex(")"), maybeexpression, comprehension, expect(")"), poplex, maybeop);
    if (type == "operator" || type == "spread") return cont(noComma ? expressionNoComma : expression);
    if (type == "[") return cont(pushlex("]"), arrayLiteral, poplex, maybeop);
    if (type == "{") return contCommasep(objprop, "}", null, maybeop);
    if (type == "quasi") { return pass(quasi, maybeop); }
    return cont();
  }
  function maybeexpression(type) {
    if (type.match(/[;\}\)\],]/)) return pass();
    return pass(expression);
  }
  function maybeexpressionNoComma(type) {
    if (type.match(/[;\}\)\],]/)) return pass();
    return pass(expressionNoComma);
  }

  function maybeoperatorComma(type, value) {
    if (type == ",") return cont(expression);
    return maybeoperatorNoComma(type, value, false);
  }
  function maybeoperatorNoComma(type, value, noComma) {
    var me = noComma == false ? maybeoperatorComma : maybeoperatorNoComma;
    var expr = noComma == false ? expression : expressionNoComma;
    if (value == "=>") return cont(pushcontext, noComma ? arrowBodyNoComma : arrowBody, popcontext);
    if (type == "operator") {
      if (/\+\+|--/.test(value)) return cont(me);
      if (value == "?") return cont(expression, expect(":"), expr);
      return cont(expr);
    }
    if (type == "quasi") { return pass(quasi, me); }
    if (type == ";") return;
    if (type == "(") return contCommasep(expressionNoComma, ")", "call", me);
    if (type == ".") return cont(property, me);
    if (type == "[") return cont(pushlex("]"), maybeexpression, expect("]"), poplex, me);
  }
  function quasi(type, value) {
    if (type != "quasi") return pass();
    if (value.slice(value.length - 2) != "${") return cont(quasi);
    return cont(expression, continueQuasi);
  }
  function continueQuasi(type) {
    if (type == "}") {
      cx.marked = "string-2";
      cx.state.tokenize = tokenQuasi;
      return cont(quasi);
    }
  }
  function arrowBody(type) {
    findFatArrow(cx.stream, cx.state);
    if (type == "{") return pass(statement);
    return pass(expression);
  }
  function arrowBodyNoComma(type) {
    findFatArrow(cx.stream, cx.state);
    if (type == "{") return pass(statement);
    return pass(expressionNoComma);
  }
  function maybelabel(type) {
    if (type == ":") return cont(poplex, statement);
    return pass(maybeoperatorComma, expect(";"), poplex);
  }
  function property(type) {
    if (type == "variable") {cx.marked = "property"; return cont();}
  }
  function objprop(type, value) {
    if (type == "variable" || cx.style == "keyword") {
      cx.marked = "property";
      if (value == "get" || value == "set") return cont(getterSetter);
      return cont(afterprop);
    } else if (type == "number" || type == "string") {
      cx.marked = jsonldMode ? "property" : (cx.style + " property");
      return cont(afterprop);
    } else if (type == "jsonld-keyword") {
      return cont(afterprop);
    } else if (type == "[") {
      return cont(expression, expect("]"), afterprop);
    }
  }
  function getterSetter(type) {
    if (type != "variable") return pass(afterprop);
    cx.marked = "property";
    return cont(functiondef);
  }
  function afterprop(type) {
    if (type == ":") return cont(expressionNoComma);
    if (type == "(") return pass(functiondef);
  }
  function commasep(what, end) {
    function proceed(type) {
      if (type == ",") {
        var lex = cx.state.lexical;
        if (lex.info == "call") lex.pos = (lex.pos || 0) + 1;
        return cont(what, proceed);
      }
      if (type == end) return cont();
      return cont(expect(end));
    }
    return function(type) {
      if (type == end) return cont();
      return pass(what, proceed);
    };
  }
  function contCommasep(what, end, info) {
    for (var i = 3; i < arguments.length; i++)
      cx.cc.push(arguments[i]);
    return cont(pushlex(end, info), commasep(what, end), poplex);
  }
  function block(type) {
    if (type == "}") return cont();
    return pass(statement, block);
  }
  function maybetype(type) {
    if (isTS && type == ":") return cont(typedef);
  }
  function typedef(type) {
    if (type == "variable"){cx.marked = "variable-3"; return cont();}
  }
  function vardef() {
    return pass(pattern, maybetype, maybeAssign, vardefCont);
  }
  function pattern(type, value) {
    if (type == "variable") { register(value); return cont(); }
    if (type == "[") return contCommasep(pattern, "]");
    if (type == "{") return contCommasep(proppattern, "}");
  }
  function proppattern(type, value) {
    if (type == "variable" && !cx.stream.match(/^\s*:/, false)) {
      register(value);
      return cont(maybeAssign);
    }
    if (type == "variable") cx.marked = "property";
    return cont(expect(":"), pattern, maybeAssign);
  }
  function maybeAssign(_type, value) {
    if (value == "=") return cont(expressionNoComma);
  }
  function vardefCont(type) {
    if (type == ",") return cont(vardef);
  }
  function maybeelse(type, value) {
    if (type == "keyword b" && value == "else") return cont(pushlex("form", "else"), statement, poplex);
  }
  function forspec(type) {
    if (type == "(") return cont(pushlex(")"), forspec1, expect(")"), poplex);
  }
  function forspec1(type) {
    if (type == "var") return cont(vardef, expect(";"), forspec2);
    if (type == ";") return cont(forspec2);
    if (type == "variable") return cont(formaybeinof);
    return pass(expression, expect(";"), forspec2);
  }
  function formaybeinof(_type, value) {
    if (value == "in" || value == "of") { cx.marked = "keyword"; return cont(expression); }
    return cont(maybeoperatorComma, forspec2);
  }
  function forspec2(type, value) {
    if (type == ";") return cont(forspec3);
    if (value == "in" || value == "of") { cx.marked = "keyword"; return cont(expression); }
    return pass(expression, expect(";"), forspec3);
  }
  function forspec3(type) {
    if (type != ")") cont(expression);
  }
  function functiondef(type, value) {
    if (value == "*") {cx.marked = "keyword"; return cont(functiondef);}
    if (type == "variable") {register(value); return cont(functiondef);}
    if (type == "(") return cont(pushcontext, pushlex(")"), commasep(funarg, ")"), poplex, statement, popcontext);
  }
  function funarg(type) {
    if (type == "spread") return cont(funarg);
    return pass(pattern, maybetype);
  }
  function className(type, value) {
    if (type == "variable") {register(value); return cont(classNameAfter);}
  }
  function classNameAfter(type, value) {
    if (value == "extends") return cont(expression, classNameAfter);
    if (type == "{") return cont(pushlex("}"), classBody, poplex);
  }
  function classBody(type, value) {
    if (type == "variable" || cx.style == "keyword") {
      cx.marked = "property";
      if (value == "get" || value == "set") return cont(classGetterSetter, functiondef, classBody);
      return cont(functiondef, classBody);
    }
    if (value == "*") {
      cx.marked = "keyword";
      return cont(classBody);
    }
    if (type == ";") return cont(classBody);
    if (type == "}") return cont();
  }
  function classGetterSetter(type) {
    if (type != "variable") return pass();
    cx.marked = "property";
    return cont();
  }
  function afterModule(type, value) {
    if (type == "string") return cont(statement);
    if (type == "variable") { register(value); return cont(maybeFrom); }
  }
  function afterExport(_type, value) {
    if (value == "*") { cx.marked = "keyword"; return cont(maybeFrom, expect(";")); }
    if (value == "default") { cx.marked = "keyword"; return cont(expression, expect(";")); }
    return pass(statement);
  }
  function afterImport(type) {
    if (type == "string") return cont();
    return pass(importSpec, maybeFrom);
  }
  function importSpec(type, value) {
    if (type == "{") return contCommasep(importSpec, "}");
    if (type == "variable") register(value);
    return cont();
  }
  function maybeFrom(_type, value) {
    if (value == "from") { cx.marked = "keyword"; return cont(expression); }
  }
  function arrayLiteral(type) {
    if (type == "]") return cont();
    return pass(expressionNoComma, maybeArrayComprehension);
  }
  function maybeArrayComprehension(type) {
    if (type == "for") return pass(comprehension, expect("]"));
    if (type == ",") return cont(commasep(expressionNoComma, "]"));
    return pass(commasep(expressionNoComma, "]"));
  }
  function comprehension(type) {
    if (type == "for") return cont(forspec, comprehension);
    if (type == "if") return cont(expression, comprehension);
  }

  // Interface

  return {
    startState: function(basecolumn) {
      var state = {
        tokenize: tokenBase,
        lastType: "sof",
        cc: [],
        lexical: new JSLexical((basecolumn || 0) - indentUnit, 0, "block", false),
        localVars: parserConfig.localVars,
        context: parserConfig.localVars && {vars: parserConfig.localVars},
        indented: 0
      };
      if (parserConfig.globalVars && typeof parserConfig.globalVars == "object")
        state.globalVars = parserConfig.globalVars;
      return state;
    },

    token: function(stream, state) {
      if (stream.sol()) {
        if (!state.lexical.hasOwnProperty("align"))
          state.lexical.align = false;
        state.indented = stream.indentation();
        findFatArrow(stream, state);
      }
      if (state.tokenize != tokenComment && stream.eatSpace()) return null;
      var style = state.tokenize(stream, state);
      if (type == "comment") return style;
      state.lastType = type == "operator" && (content == "++" || content == "--") ? "incdec" : type;
      return parseJS(state, style, type, content, stream);
    },

    indent: function(state, textAfter) {
      if (state.tokenize == tokenComment) return CodeMirror.Pass;
      if (state.tokenize != tokenBase) return 0;
      var firstChar = textAfter && textAfter.charAt(0), lexical = state.lexical;
      // Kludge to prevent 'maybelse' from blocking lexical scope pops
      if (!/^\s*else\b/.test(textAfter)) for (var i = state.cc.length - 1; i >= 0; --i) {
        var c = state.cc[i];
        if (c == poplex) lexical = lexical.prev;
        else if (c != maybeelse) break;
      }
      if (lexical.type == "stat" && firstChar == "}") lexical = lexical.prev;
      if (statementIndent && lexical.type == ")" && lexical.prev.type == "stat")
        lexical = lexical.prev;
      var type = lexical.type, closing = firstChar == type;

      if (type == "vardef") return lexical.indented + (state.lastType == "operator" || state.lastType == "," ? lexical.info + 1 : 0);
      else if (type == "form" && firstChar == "{") return lexical.indented;
      else if (type == "form") return lexical.indented + indentUnit;
      else if (type == "stat")
        return lexical.indented + (state.lastType == "operator" || state.lastType == "," ? statementIndent || indentUnit : 0);
      else if (lexical.info == "switch" && !closing && parserConfig.doubleIndentSwitch != false)
        return lexical.indented + (/^(?:case|default)\b/.test(textAfter) ? indentUnit : 2 * indentUnit);
      else if (lexical.align) return lexical.column + (closing ? 0 : 1);
      else return lexical.indented + (closing ? 0 : indentUnit);
    },

    electricChars: ":{}",
    blockCommentStart: jsonMode ? null : "/*",
    blockCommentEnd: jsonMode ? null : "*/",
    lineComment: jsonMode ? null : "//",
    fold: "brace",

    helperType: jsonMode ? "json" : "javascript",
    jsonldMode: jsonldMode,
    jsonMode: jsonMode
  };
});

CodeMirror.registerHelper("wordChars", "javascript", /[\\w$]/);

CodeMirror.defineMIME("text/javascript", "javascript");
CodeMirror.defineMIME("text/ecmascript", "javascript");
CodeMirror.defineMIME("application/javascript", "javascript");
CodeMirror.defineMIME("application/x-javascript", "javascript");
CodeMirror.defineMIME("application/ecmascript", "javascript");
CodeMirror.defineMIME("application/json", {name: "javascript", json: true});
CodeMirror.defineMIME("application/x-json", {name: "javascript", json: true});
CodeMirror.defineMIME("application/ld+json", {name: "javascript", jsonld: true});
CodeMirror.defineMIME("text/typescript", { name: "javascript", typescript: true });
CodeMirror.defineMIME("application/typescript", { name: "javascript", typescript: true });

});


// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";
  var Pos = CodeMirror.Pos;

  function SearchCursor(doc, query, pos, caseFold) {
    this.atOccurrence = false; this.doc = doc;
    if (caseFold == null && typeof query == "string") caseFold = false;

    pos = pos ? doc.clipPos(pos) : Pos(0, 0);
    this.pos = {from: pos, to: pos};

    // The matches method is filled in based on the type of query.
    // It takes a position and a direction, and returns an object
    // describing the next occurrence of the query, or null if no
    // more matches were found.
    if (typeof query != "string") { // Regexp match
      if (!query.global) query = new RegExp(query.source, query.ignoreCase ? "ig" : "g");
      this.matches = function(reverse, pos) {
        if (reverse) {
          query.lastIndex = 0;
          var line = doc.getLine(pos.line).slice(0, pos.ch), cutOff = 0, match, start;
          for (;;) {
            query.lastIndex = cutOff;
            var newMatch = query.exec(line);
            if (!newMatch) break;
            match = newMatch;
            start = match.index;
            cutOff = match.index + (match[0].length || 1);
            if (cutOff == line.length) break;
          }
          var matchLen = (match && match[0].length) || 0;
          if (!matchLen) {
            if (start == 0 && line.length == 0) {match = undefined;}
            else if (start != doc.getLine(pos.line).length) {
              matchLen++;
            }
          }
        } else {
          query.lastIndex = pos.ch;
          var line = doc.getLine(pos.line), match = query.exec(line);
          var matchLen = (match && match[0].length) || 0;
          var start = match && match.index;
          if (start + matchLen != line.length && !matchLen) matchLen = 1;
        }
        if (match && matchLen)
          return {from: Pos(pos.line, start),
                  to: Pos(pos.line, start + matchLen),
                  match: match};
      };
    } else { // String query
      var origQuery = query;
      if (caseFold) query = query.toLowerCase();
      var fold = caseFold ? function(str){return str.toLowerCase();} : function(str){return str;};
      var target = query.split("\n");
      // Different methods for single-line and multi-line queries
      if (target.length == 1) {
        if (!query.length) {
          // Empty string would match anything and never progress, so
          // we define it to match nothing instead.
          this.matches = function() {};
        } else {
          this.matches = function(reverse, pos) {
            if (reverse) {
              var orig = doc.getLine(pos.line).slice(0, pos.ch), line = fold(orig);
              var match = line.lastIndexOf(query);
              if (match > -1) {
                match = adjustPos(orig, line, match);
                return {from: Pos(pos.line, match), to: Pos(pos.line, match + origQuery.length)};
              }
             } else {
               var orig = doc.getLine(pos.line).slice(pos.ch), line = fold(orig);
               var match = line.indexOf(query);
               if (match > -1) {
                 match = adjustPos(orig, line, match) + pos.ch;
                 return {from: Pos(pos.line, match), to: Pos(pos.line, match + origQuery.length)};
               }
            }
          };
        }
      } else {
        var origTarget = origQuery.split("\n");
        this.matches = function(reverse, pos) {
          var last = target.length - 1;
          if (reverse) {
            if (pos.line - (target.length - 1) < doc.firstLine()) return;
            if (fold(doc.getLine(pos.line).slice(0, origTarget[last].length)) != target[target.length - 1]) return;
            var to = Pos(pos.line, origTarget[last].length);
            for (var ln = pos.line - 1, i = last - 1; i >= 1; --i, --ln)
              if (target[i] != fold(doc.getLine(ln))) return;
            var line = doc.getLine(ln), cut = line.length - origTarget[0].length;
            if (fold(line.slice(cut)) != target[0]) return;
            return {from: Pos(ln, cut), to: to};
          } else {
            if (pos.line + (target.length - 1) > doc.lastLine()) return;
            var line = doc.getLine(pos.line), cut = line.length - origTarget[0].length;
            if (fold(line.slice(cut)) != target[0]) return;
            var from = Pos(pos.line, cut);
            for (var ln = pos.line + 1, i = 1; i < last; ++i, ++ln)
              if (target[i] != fold(doc.getLine(ln))) return;
            if (doc.getLine(ln).slice(0, origTarget[last].length) != target[last]) return;
            return {from: from, to: Pos(ln, origTarget[last].length)};
          }
        };
      }
    }
  }

  SearchCursor.prototype = {
    findNext: function() {return this.find(false);},
    findPrevious: function() {return this.find(true);},

    find: function(reverse) {
      var self = this, pos = this.doc.clipPos(reverse ? this.pos.from : this.pos.to);
      function savePosAndFail(line) {
        var pos = Pos(line, 0);
        self.pos = {from: pos, to: pos};
        self.atOccurrence = false;
        return false;
      }

      for (;;) {
        if (this.pos = this.matches(reverse, pos)) {
          this.atOccurrence = true;
          return this.pos.match || true;
        }
        if (reverse) {
          if (!pos.line) return savePosAndFail(0);
          pos = Pos(pos.line-1, this.doc.getLine(pos.line-1).length);
        }
        else {
          var maxLine = this.doc.lineCount();
          if (pos.line == maxLine - 1) return savePosAndFail(maxLine);
          pos = Pos(pos.line + 1, 0);
        }
      }
    },

    from: function() {if (this.atOccurrence) return this.pos.from;},
    to: function() {if (this.atOccurrence) return this.pos.to;},

    replace: function(newText) {
      if (!this.atOccurrence) return;
      var lines = CodeMirror.splitLines(newText);
      this.doc.replaceRange(lines, this.pos.from, this.pos.to);
      this.pos.to = Pos(this.pos.from.line + lines.length - 1,
                        lines[lines.length - 1].length + (lines.length == 1 ? this.pos.from.ch : 0));
    }
  };

  // Maps a position in a case-folded line back to a position in the original line
  // (compensating for codepoints increasing in number during folding)
  function adjustPos(orig, folded, pos) {
    if (orig.length == folded.length) return pos;
    for (var pos1 = Math.min(pos, orig.length);;) {
      var len1 = orig.slice(0, pos1).toLowerCase().length;
      if (len1 < pos) ++pos1;
      else if (len1 > pos) --pos1;
      else return pos1;
    }
  }

  CodeMirror.defineExtension("getSearchCursor", function(query, pos, caseFold) {
    return new SearchCursor(this.doc, query, pos, caseFold);
  });
  CodeMirror.defineDocExtension("getSearchCursor", function(query, pos, caseFold) {
    return new SearchCursor(this, query, pos, caseFold);
  });

  CodeMirror.defineExtension("selectMatches", function(query, caseFold) {
    var ranges = [], next;
    var cur = this.getSearchCursor(query, this.getCursor("from"), caseFold);
    while (next = cur.findNext()) {
      if (CodeMirror.cmpPos(cur.to(), this.getCursor("to")) > 0) break;
      ranges.push({anchor: cur.from(), head: cur.to()});
    }
    if (ranges.length)
      this.setSelections(ranges, 0);
  });
});


/*
  Copyright (C) 2012-2013 Yusuke Suzuki <utatane.tea@gmail.com>
  Copyright (C) 2012 Ariya Hidayat <ariya.hidayat@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/*jslint vars:false, bitwise:true*/
/*jshint indent:4*/
/*global exports:true, define:true*/
(function (root, factory) {
    'use strict';

    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js,
    // and plain browser loading,
    if (typeof define === 'function' && define.amd) {
        define(['exports'], factory);
    } else if (typeof exports !== 'undefined') {
        factory(exports);
    } else {
        factory((root.estraverse = {}));
    }
}(this, function (exports) {
    'use strict';

    var Syntax,
        isArray,
        VisitorOption,
        VisitorKeys,
        objectCreate,
        objectKeys,
        BREAK,
        SKIP,
        REMOVE;

    function ignoreJSHintError() { }

    isArray = Array.isArray;
    if (!isArray) {
        isArray = function isArray(array) {
            return Object.prototype.toString.call(array) === '[object Array]';
        };
    }

    function deepCopy(obj) {
        var ret = {}, key, val;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                val = obj[key];
                if (typeof val === 'object' && val !== null) {
                    ret[key] = deepCopy(val);
                } else {
                    ret[key] = val;
                }
            }
        }
        return ret;
    }

    function shallowCopy(obj) {
        var ret = {}, key;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                ret[key] = obj[key];
            }
        }
        return ret;
    }
    ignoreJSHintError(shallowCopy);

    // based on LLVM libc++ upper_bound / lower_bound
    // MIT License

    function upperBound(array, func) {
        var diff, len, i, current;

        len = array.length;
        i = 0;

        while (len) {
            diff = len >>> 1;
            current = i + diff;
            if (func(array[current])) {
                len = diff;
            } else {
                i = current + 1;
                len -= diff + 1;
            }
        }
        return i;
    }

    function lowerBound(array, func) {
        var diff, len, i, current;

        len = array.length;
        i = 0;

        while (len) {
            diff = len >>> 1;
            current = i + diff;
            if (func(array[current])) {
                i = current + 1;
                len -= diff + 1;
            } else {
                len = diff;
            }
        }
        return i;
    }
    ignoreJSHintError(lowerBound);

    objectCreate = Object.create || (function () {
        function F() { }

        return function (o) {
            F.prototype = o;
            return new F();
        };
    })();

    objectKeys = Object.keys || function (o) {
        var keys = [], key;
        for (key in o) {
            keys.push(key);
        }
        return keys;
    };

    function extend(to, from) {
        objectKeys(from).forEach(function (key) {
            to[key] = from[key];
        });
        return to;
    }

    Syntax = {
        AssignmentExpression: 'AssignmentExpression',
        ArrayExpression: 'ArrayExpression',
        ArrayPattern: 'ArrayPattern',
        ArrowFunctionExpression: 'ArrowFunctionExpression',
        BlockStatement: 'BlockStatement',
        BinaryExpression: 'BinaryExpression',
        BreakStatement: 'BreakStatement',
        CallExpression: 'CallExpression',
        CatchClause: 'CatchClause',
        ClassBody: 'ClassBody',
        ClassDeclaration: 'ClassDeclaration',
        ClassExpression: 'ClassExpression',
        ComprehensionBlock: 'ComprehensionBlock',  // CAUTION: It's deferred to ES7.
        ComprehensionExpression: 'ComprehensionExpression',  // CAUTION: It's deferred to ES7.
        ConditionalExpression: 'ConditionalExpression',
        ContinueStatement: 'ContinueStatement',
        DebuggerStatement: 'DebuggerStatement',
        DirectiveStatement: 'DirectiveStatement',
        DoWhileStatement: 'DoWhileStatement',
        EmptyStatement: 'EmptyStatement',
        ExportBatchSpecifier: 'ExportBatchSpecifier',
        ExportDeclaration: 'ExportDeclaration',
        ExportSpecifier: 'ExportSpecifier',
        ExpressionStatement: 'ExpressionStatement',
        ForStatement: 'ForStatement',
        ForInStatement: 'ForInStatement',
        ForOfStatement: 'ForOfStatement',
        FunctionDeclaration: 'FunctionDeclaration',
        FunctionExpression: 'FunctionExpression',
        GeneratorExpression: 'GeneratorExpression',  // CAUTION: It's deferred to ES7.
        Identifier: 'Identifier',
        IfStatement: 'IfStatement',
        ImportDeclaration: 'ImportDeclaration',
        ImportDefaultSpecifier: 'ImportDefaultSpecifier',
        ImportNamespaceSpecifier: 'ImportNamespaceSpecifier',
        ImportSpecifier: 'ImportSpecifier',
        Literal: 'Literal',
        LabeledStatement: 'LabeledStatement',
        LogicalExpression: 'LogicalExpression',
        MemberExpression: 'MemberExpression',
        MethodDefinition: 'MethodDefinition',
        ModuleSpecifier: 'ModuleSpecifier',
        NewExpression: 'NewExpression',
        ObjectExpression: 'ObjectExpression',
        ObjectPattern: 'ObjectPattern',
        Program: 'Program',
        Property: 'Property',
        ReturnStatement: 'ReturnStatement',
        SequenceExpression: 'SequenceExpression',
        SpreadElement: 'SpreadElement',
        SwitchStatement: 'SwitchStatement',
        SwitchCase: 'SwitchCase',
        TaggedTemplateExpression: 'TaggedTemplateExpression',
        TemplateElement: 'TemplateElement',
        TemplateLiteral: 'TemplateLiteral',
        ThisExpression: 'ThisExpression',
        ThrowStatement: 'ThrowStatement',
        TryStatement: 'TryStatement',
        UnaryExpression: 'UnaryExpression',
        UpdateExpression: 'UpdateExpression',
        VariableDeclaration: 'VariableDeclaration',
        VariableDeclarator: 'VariableDeclarator',
        WhileStatement: 'WhileStatement',
        WithStatement: 'WithStatement',
        YieldExpression: 'YieldExpression'
    };

    VisitorKeys = {
        AssignmentExpression: ['left', 'right'],
        ArrayExpression: ['elements'],
        ArrayPattern: ['elements'],
        ArrowFunctionExpression: ['params', 'defaults', 'rest', 'body'],
        BlockStatement: ['body'],
        BinaryExpression: ['left', 'right'],
        BreakStatement: ['label'],
        CallExpression: ['callee', 'arguments'],
        CatchClause: ['param', 'body'],
        ClassBody: ['body'],
        ClassDeclaration: ['id', 'body', 'superClass'],
        ClassExpression: ['id', 'body', 'superClass'],
        ComprehensionBlock: ['left', 'right'],  // CAUTION: It's deferred to ES7.
        ComprehensionExpression: ['blocks', 'filter', 'body'],  // CAUTION: It's deferred to ES7.
        ConditionalExpression: ['test', 'consequent', 'alternate'],
        ContinueStatement: ['label'],
        DebuggerStatement: [],
        DirectiveStatement: [],
        DoWhileStatement: ['body', 'test'],
        EmptyStatement: [],
        ExportBatchSpecifier: [],
        ExportDeclaration: ['declaration', 'specifiers', 'source'],
        ExportSpecifier: ['id', 'name'],
        ExpressionStatement: ['expression'],
        ForStatement: ['init', 'test', 'update', 'body'],
        ForInStatement: ['left', 'right', 'body'],
        ForOfStatement: ['left', 'right', 'body'],
        FunctionDeclaration: ['id', 'params', 'defaults', 'rest', 'body'],
        FunctionExpression: ['id', 'params', 'defaults', 'rest', 'body'],
        GeneratorExpression: ['blocks', 'filter', 'body'],  // CAUTION: It's deferred to ES7.
        Identifier: [],
        IfStatement: ['test', 'consequent', 'alternate'],
        ImportDeclaration: ['specifiers', 'source'],
        ImportDefaultSpecifier: ['id'],
        ImportNamespaceSpecifier: ['id'],
        ImportSpecifier: ['id', 'name'],
        Literal: [],
        LabeledStatement: ['label', 'body'],
        LogicalExpression: ['left', 'right'],
        MemberExpression: ['object', 'property'],
        MethodDefinition: ['key', 'value'],
        ModuleSpecifier: [],
        NewExpression: ['callee', 'arguments'],
        ObjectExpression: ['properties'],
        ObjectPattern: ['properties'],
        Program: ['body'],
        Property: ['key', 'value'],
        ReturnStatement: ['argument'],
        SequenceExpression: ['expressions'],
        SpreadElement: ['argument'],
        SwitchStatement: ['discriminant', 'cases'],
        SwitchCase: ['test', 'consequent'],
        TaggedTemplateExpression: ['tag', 'quasi'],
        TemplateElement: [],
        TemplateLiteral: ['quasis', 'expressions'],
        ThisExpression: [],
        ThrowStatement: ['argument'],
        TryStatement: ['block', 'handlers', 'handler', 'guardedHandlers', 'finalizer'],
        UnaryExpression: ['argument'],
        UpdateExpression: ['argument'],
        VariableDeclaration: ['declarations'],
        VariableDeclarator: ['id', 'init'],
        WhileStatement: ['test', 'body'],
        WithStatement: ['object', 'body'],
        YieldExpression: ['argument']
    };

    // unique id
    BREAK = {};
    SKIP = {};
    REMOVE = {};

    VisitorOption = {
        Break: BREAK,
        Skip: SKIP,
        Remove: REMOVE
    };

    function Reference(parent, key) {
        this.parent = parent;
        this.key = key;
    }

    Reference.prototype.replace = function replace(node) {
        this.parent[this.key] = node;
    };

    Reference.prototype.remove = function remove() {
        if (isArray(this.parent)) {
            this.parent.splice(this.key, 1);
            return true;
        } else {
            this.replace(null);
            return false;
        }
    };

    function Element(node, path, wrap, ref) {
        this.node = node;
        this.path = path;
        this.wrap = wrap;
        this.ref = ref;
    }

    function Controller() { }

    // API:
    // return property path array from root to current node
    Controller.prototype.path = function path() {
        var i, iz, j, jz, result, element;

        function addToPath(result, path) {
            if (isArray(path)) {
                for (j = 0, jz = path.length; j < jz; ++j) {
                    result.push(path[j]);
                }
            } else {
                result.push(path);
            }
        }

        // root node
        if (!this.__current.path) {
            return null;
        }

        // first node is sentinel, second node is root element
        result = [];
        for (i = 2, iz = this.__leavelist.length; i < iz; ++i) {
            element = this.__leavelist[i];
            addToPath(result, element.path);
        }
        addToPath(result, this.__current.path);
        return result;
    };

    // API:
    // return array of parent elements
    Controller.prototype.parents = function parents() {
        var i, iz, result;

        // first node is sentinel
        result = [];
        for (i = 1, iz = this.__leavelist.length; i < iz; ++i) {
            result.push(this.__leavelist[i].node);
        }

        return result;
    };

    // API:
    // return current node
    Controller.prototype.current = function current() {
        return this.__current.node;
    };

    Controller.prototype.__execute = function __execute(callback, element) {
        var previous, result;

        result = undefined;

        previous  = this.__current;
        this.__current = element;
        this.__state = null;
        if (callback) {
            result = callback.call(this, element.node, this.__leavelist[this.__leavelist.length - 1].node);
        }
        this.__current = previous;

        return result;
    };

    // API:
    // notify control skip / break
    Controller.prototype.notify = function notify(flag) {
        this.__state = flag;
    };

    // API:
    // skip child nodes of current node
    Controller.prototype.skip = function () {
        this.notify(SKIP);
    };

    // API:
    // break traversals
    Controller.prototype['break'] = function () {
        this.notify(BREAK);
    };

    // API:
    // remove node
    Controller.prototype.remove = function () {
        this.notify(REMOVE);
    };

    Controller.prototype.__initialize = function(root, visitor) {
        this.visitor = visitor;
        this.root = root;
        this.__worklist = [];
        this.__leavelist = [];
        this.__current = null;
        this.__state = null;
        this.__fallback = visitor.fallback === 'iteration';
        this.__keys = VisitorKeys;
        if (visitor.keys) {
            this.__keys = extend(objectCreate(this.__keys), visitor.keys);
        }
    };

    function isNode(node) {
        if (node == null) {
            return false;
        }
        return typeof node === 'object' && typeof node.type === 'string';
    }

    function isProperty(nodeType, key) {
        return (nodeType === Syntax.ObjectExpression || nodeType === Syntax.ObjectPattern) && 'properties' === key;
    }

    Controller.prototype.traverse = function traverse(root, visitor) {
        var worklist,
            leavelist,
            element,
            node,
            nodeType,
            ret,
            key,
            current,
            current2,
            candidates,
            candidate,
            sentinel;

        this.__initialize(root, visitor);

        sentinel = {};

        // reference
        worklist = this.__worklist;
        leavelist = this.__leavelist;

        // initialize
        worklist.push(new Element(root, null, null, null));
        leavelist.push(new Element(null, null, null, null));

        while (worklist.length) {
            element = worklist.pop();

            if (element === sentinel) {
                element = leavelist.pop();

                ret = this.__execute(visitor.leave, element);

                if (this.__state === BREAK || ret === BREAK) {
                    return;
                }
                continue;
            }

            if (element.node) {

                ret = this.__execute(visitor.enter, element);

                if (this.__state === BREAK || ret === BREAK) {
                    return;
                }

                worklist.push(sentinel);
                leavelist.push(element);

                if (this.__state === SKIP || ret === SKIP) {
                    continue;
                }

                node = element.node;
                nodeType = element.wrap || node.type;
                candidates = this.__keys[nodeType];
                if (!candidates) {
                    if (this.__fallback) {
                        candidates = objectKeys(node);
                    } else {
                        throw new Error('Unknown node type ' + nodeType + '.');
                    }
                }

                current = candidates.length;
                while ((current -= 1) >= 0) {
                    key = candidates[current];
                    candidate = node[key];
                    if (!candidate) {
                        continue;
                    }

                    if (isArray(candidate)) {
                        current2 = candidate.length;
                        while ((current2 -= 1) >= 0) {
                            if (!candidate[current2]) {
                                continue;
                            }
                            if (isProperty(nodeType, candidates[current])) {
                                element = new Element(candidate[current2], [key, current2], 'Property', null);
                            } else if (isNode(candidate[current2])) {
                                element = new Element(candidate[current2], [key, current2], null, null);
                            } else {
                                continue;
                            }
                            worklist.push(element);
                        }
                    } else if (isNode(candidate)) {
                        worklist.push(new Element(candidate, key, null, null));
                    }
                }
            }
        }
    };

    Controller.prototype.replace = function replace(root, visitor) {
        function removeElem(element) {
            var i,
                key,
                nextElem,
                parent;

            if (element.ref.remove()) {
                // When the reference is an element of an array.
                key = element.ref.key;
                parent = element.ref.parent;

                // If removed from array, then decrease following items' keys.
                i = worklist.length;
                while (i--) {
                    nextElem = worklist[i];
                    if (nextElem.ref && nextElem.ref.parent === parent) {
                        if  (nextElem.ref.key < key) {
                            break;
                        }
                        --nextElem.ref.key;
                    }
                }
            }
        }

        var worklist,
            leavelist,
            node,
            nodeType,
            target,
            element,
            current,
            current2,
            candidates,
            candidate,
            sentinel,
            outer,
            key;

        this.__initialize(root, visitor);

        sentinel = {};

        // reference
        worklist = this.__worklist;
        leavelist = this.__leavelist;

        // initialize
        outer = {
            root: root
        };
        element = new Element(root, null, null, new Reference(outer, 'root'));
        worklist.push(element);
        leavelist.push(element);

        while (worklist.length) {
            element = worklist.pop();

            if (element === sentinel) {
                element = leavelist.pop();

                target = this.__execute(visitor.leave, element);

                // node may be replaced with null,
                // so distinguish between undefined and null in this place
                if (target !== undefined && target !== BREAK && target !== SKIP && target !== REMOVE) {
                    // replace
                    element.ref.replace(target);
                }

                if (this.__state === REMOVE || target === REMOVE) {
                    removeElem(element);
                }

                if (this.__state === BREAK || target === BREAK) {
                    return outer.root;
                }
                continue;
            }

            target = this.__execute(visitor.enter, element);

            // node may be replaced with null,
            // so distinguish between undefined and null in this place
            if (target !== undefined && target !== BREAK && target !== SKIP && target !== REMOVE) {
                // replace
                element.ref.replace(target);
                element.node = target;
            }

            if (this.__state === REMOVE || target === REMOVE) {
                removeElem(element);
                element.node = null;
            }

            if (this.__state === BREAK || target === BREAK) {
                return outer.root;
            }

            // node may be null
            node = element.node;
            if (!node) {
                continue;
            }

            worklist.push(sentinel);
            leavelist.push(element);

            if (this.__state === SKIP || target === SKIP) {
                continue;
            }

            nodeType = element.wrap || node.type;
            candidates = this.__keys[nodeType];
            if (!candidates) {
                if (this.__fallback) {
                    candidates = objectKeys(node);
                } else {
                    throw new Error('Unknown node type ' + nodeType + '.');
                }
            }

            current = candidates.length;
            while ((current -= 1) >= 0) {
                key = candidates[current];
                candidate = node[key];
                if (!candidate) {
                    continue;
                }

                if (isArray(candidate)) {
                    current2 = candidate.length;
                    while ((current2 -= 1) >= 0) {
                        if (!candidate[current2]) {
                            continue;
                        }
                        if (isProperty(nodeType, candidates[current])) {
                            element = new Element(candidate[current2], [key, current2], 'Property', new Reference(candidate, current2));
                        } else if (isNode(candidate[current2])) {
                            element = new Element(candidate[current2], [key, current2], null, new Reference(candidate, current2));
                        } else {
                            continue;
                        }
                        worklist.push(element);
                    }
                } else if (isNode(candidate)) {
                    worklist.push(new Element(candidate, key, null, new Reference(node, key)));
                }
            }
        }

        return outer.root;
    };

    function traverse(root, visitor) {
        var controller = new Controller();
        return controller.traverse(root, visitor);
    }

    function replace(root, visitor) {
        var controller = new Controller();
        return controller.replace(root, visitor);
    }

    function extendCommentRange(comment, tokens) {
        var target;

        target = upperBound(tokens, function search(token) {
            return token.range[0] > comment.range[0];
        });

        comment.extendedRange = [comment.range[0], comment.range[1]];

        if (target !== tokens.length) {
            comment.extendedRange[1] = tokens[target].range[0];
        }

        target -= 1;
        if (target >= 0) {
            comment.extendedRange[0] = tokens[target].range[1];
        }

        return comment;
    }

    function attachComments(tree, providedComments, tokens) {
        // At first, we should calculate extended comment ranges.
        var comments = [], comment, len, i, cursor;

        if (!tree.range) {
            throw new Error('attachComments needs range information');
        }

        // tokens array is empty, we attach comments to tree as 'leadingComments'
        if (!tokens.length) {
            if (providedComments.length) {
                for (i = 0, len = providedComments.length; i < len; i += 1) {
                    comment = deepCopy(providedComments[i]);
                    comment.extendedRange = [0, tree.range[0]];
                    comments.push(comment);
                }
                tree.leadingComments = comments;
            }
            return tree;
        }

        for (i = 0, len = providedComments.length; i < len; i += 1) {
            comments.push(extendCommentRange(deepCopy(providedComments[i]), tokens));
        }

        // This is based on John Freeman's implementation.
        cursor = 0;
        traverse(tree, {
            enter: function (node) {
                var comment;

                while (cursor < comments.length) {
                    comment = comments[cursor];
                    if (comment.extendedRange[1] > node.range[0]) {
                        break;
                    }

                    if (comment.extendedRange[1] === node.range[0]) {
                        if (!node.leadingComments) {
                            node.leadingComments = [];
                        }
                        node.leadingComments.push(comment);
                        comments.splice(cursor, 1);
                    } else {
                        cursor += 1;
                    }
                }

                // already out of owned node
                if (cursor === comments.length) {
                    return VisitorOption.Break;
                }

                if (comments[cursor].extendedRange[0] > node.range[1]) {
                    return VisitorOption.Skip;
                }
            }
        });

        cursor = 0;
        traverse(tree, {
            leave: function (node) {
                var comment;

                while (cursor < comments.length) {
                    comment = comments[cursor];
                    if (node.range[1] < comment.extendedRange[0]) {
                        break;
                    }

                    if (node.range[1] === comment.extendedRange[0]) {
                        if (!node.trailingComments) {
                            node.trailingComments = [];
                        }
                        node.trailingComments.push(comment);
                        comments.splice(cursor, 1);
                    } else {
                        cursor += 1;
                    }
                }

                // already out of owned node
                if (cursor === comments.length) {
                    return VisitorOption.Break;
                }

                if (comments[cursor].extendedRange[0] > node.range[1]) {
                    return VisitorOption.Skip;
                }
            }
        });

        return tree;
    }

    exports.version = '1.7.1';
    exports.Syntax = Syntax;
    exports.traverse = traverse;
    exports.replace = replace;
    exports.attachComments = attachComments;
    exports.VisitorKeys = VisitorKeys;
    exports.VisitorOption = VisitorOption;
    exports.Controller = Controller;
}));
/* vim: set sw=4 ts=4 et tw=80 : */


/*
	Ractive.js v0.7.0-edge
	Fri Feb 06 2015 17:32:02 GMT+0000 (UTC) - commit 76466b38a3621e64c736cf6848189f4c95f36bcc

	http://ractivejs.org
	http://twitter.com/RactiveJS

	Released under the MIT License.
*/

(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  global.Ractive = factory()
}(this, function () { 'use strict';

  var TEMPLATE_VERSION = 3;
  //# sourceMappingURL=02-6to5-template.js.map

  var defaultOptions = {

    // render placement:
    el: void 0,
    append: false,

    // template:
    template: { v: TEMPLATE_VERSION, t: [] },

    // parse:     // TODO static delimiters?
    preserveWhitespace: false,
    sanitize: false,
    stripComments: true,
    delimiters: ["{{", "}}"],
    tripleDelimiters: ["{{{", "}}}"],
    interpolate: false,

    // data & binding:
    data: {},
    computed: {},
    magic: false,
    modifyArrays: true,
    adapt: [],
    isolated: false,
    parameters: true,
    twoway: true,
    lazy: false,

    // transitions:
    noIntro: false,
    transitionsEnabled: true,
    complete: void 0,

    // css:
    css: null,
    noCssTransform: false,

    // debug:
    debug: false
  };

  var defaults = defaultOptions;
  //# sourceMappingURL=02-6to5-defaults.js.map

  // These are a subset of the easing equations found at
  // https://raw.github.com/danro/easing-js - license info
  // follows:

  // --------------------------------------------------
  // easing.js v0.5.4
  // Generic set of easing functions with AMD support
  // https://github.com/danro/easing-js
  // This code may be freely distributed under the MIT license
  // http://danro.mit-license.org/
  // --------------------------------------------------
  // All functions adapted from Thomas Fuchs & Jeremy Kahn
  // Easing Equations (c) 2003 Robert Penner, BSD license
  // https://raw.github.com/danro/easing-js/master/LICENSE
  // --------------------------------------------------

  // In that library, the functions named easeIn, easeOut, and
  // easeInOut below are named easeInCubic, easeOutCubic, and
  // (you guessed it) easeInOutCubic.
  //
  // You can add additional easing functions to this list, and they
  // will be globally available.


  var easing__default = {
    linear: function (pos) {
      return pos;
    },
    easeIn: function (pos) {
      return Math.pow(pos, 3);
    },
    easeOut: function (pos) {
      return Math.pow(pos - 1, 3) + 1;
    },
    easeInOut: function (pos) {
      if ((pos /= 0.5) < 1) {
        return 0.5 * Math.pow(pos, 3);
      }
      return 0.5 * (Math.pow(pos - 2, 3) + 2);
    }
  };
  //# sourceMappingURL=02-6to5-easing.js.map

  /*global console */
  var isClient, hasConsole, magic, namespaces, svg, vendors;

  isClient = typeof document === "object";

  hasConsole = typeof console !== "undefined" && typeof console.warn === "function" && typeof console.warn.apply === "function";

  try {
    Object.defineProperty({}, "test", { value: 0 });
    magic = true;
  } catch (e) {
    magic = false;
  }

  namespaces = {
    html: "http://www.w3.org/1999/xhtml",
    mathml: "http://www.w3.org/1998/Math/MathML",
    svg: "http://www.w3.org/2000/svg",
    xlink: "http://www.w3.org/1999/xlink",
    xml: "http://www.w3.org/XML/1998/namespace",
    xmlns: "http://www.w3.org/2000/xmlns/"
  };

  if (typeof document === "undefined") {
    svg = false;
  } else {
    svg = document && document.implementation.hasFeature("http://www.w3.org/TR/SVG11/feature#BasicStructure", "1.1");
  }

  vendors = ["o", "ms", "moz", "webkit"];

  var createElement, matches, dom__div, methodNames, unprefixed, prefixed, dom__i, j, makeFunction;

  // Test for SVG support
  if (!svg) {
    createElement = function (type, ns) {
      if (ns && ns !== namespaces.html) {
        throw "This browser does not support namespaces other than http://www.w3.org/1999/xhtml. The most likely cause of this error is that you're trying to render SVG in an older browser. See http://docs.ractivejs.org/latest/svg-and-older-browsers for more information";
      }

      return document.createElement(type);
    };
  } else {
    createElement = function (type, ns) {
      if (!ns || ns === namespaces.html) {
        return document.createElement(type);
      }

      return document.createElementNS(ns, type);
    };
  }

  function getElement(input) {
    var output;

    if (!input || typeof input === "boolean") {
      return;
    }

    if (typeof window === "undefined" || !document || !input) {
      return null;
    }

    // We already have a DOM node - no work to do. (Duck typing alert!)
    if (input.nodeType) {
      return input;
    }

    // Get node from string
    if (typeof input === "string") {
      // try ID first
      output = document.getElementById(input);

      // then as selector, if possible
      if (!output && document.querySelector) {
        output = document.querySelector(input);
      }

      // did it work?
      if (output && output.nodeType) {
        return output;
      }
    }

    // If we've been given a collection (jQuery, Zepto etc), extract the first item
    if (input[0] && input[0].nodeType) {
      return input[0];
    }

    return null;
  }

  if (!isClient) {
    matches = null;
  } else {
    dom__div = createElement("div");
    methodNames = ["matches", "matchesSelector"];

    makeFunction = function (methodName) {
      return function (node, selector) {
        return node[methodName](selector);
      };
    };

    dom__i = methodNames.length;

    while (dom__i-- && !matches) {
      unprefixed = methodNames[dom__i];

      if (dom__div[unprefixed]) {
        matches = makeFunction(unprefixed);
      } else {
        j = vendors.length;
        while (j--) {
          prefixed = vendors[dom__i] + unprefixed.substr(0, 1).toUpperCase() + unprefixed.substring(1);

          if (dom__div[prefixed]) {
            matches = makeFunction(prefixed);
            break;
          }
        }
      }
    }

    // IE8...
    if (!matches) {
      matches = function (node, selector) {
        var nodes, parentNode, i;

        parentNode = node.parentNode;

        if (!parentNode) {
          // empty dummy <div>
          dom__div.innerHTML = "";

          parentNode = dom__div;
          node = node.cloneNode();

          dom__div.appendChild(node);
        }

        nodes = parentNode.querySelectorAll(selector);

        i = nodes.length;
        while (i--) {
          if (nodes[i] === node) {
            return true;
          }
        }

        return false;
      };
    }
  }

  function detachNode(node) {
    if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }

    return node;
  }

  var win, doc, exportedShims;

  if (typeof window === "undefined") {
    exportedShims = null;
  } else {
    win = window;
    doc = win.document;
    exportedShims = {};

    if (!doc) {
      exportedShims = null;
    }

    // Shims for older browsers

    if (!Date.now) {
      Date.now = function () {
        return +new Date();
      };
    }

    if (!String.prototype.trim) {
      String.prototype.trim = function () {
        return this.replace(/^\s+/, "").replace(/\s+$/, "");
      };
    }

    // Polyfill for Object.keys
    // https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/keys
    if (!Object.keys) {
      Object.keys = (function () {
        var hasOwnProperty = Object.prototype.hasOwnProperty,
            hasDontEnumBug = !({ toString: null }).propertyIsEnumerable("toString"),
            dontEnums = ["toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "constructor"],
            dontEnumsLength = dontEnums.length;

        return function (obj) {
          if (typeof obj !== "object" && typeof obj !== "function" || obj === null) {
            throw new TypeError("Object.keys called on non-object");
          }

          var result = [];

          for (var prop in obj) {
            if (hasOwnProperty.call(obj, prop)) {
              result.push(prop);
            }
          }

          if (hasDontEnumBug) {
            for (var i = 0; i < dontEnumsLength; i++) {
              if (hasOwnProperty.call(obj, dontEnums[i])) {
                result.push(dontEnums[i]);
              }
            }
          }
          return result;
        };
      })();
    }

    // TODO: use defineProperty to make these non-enumerable

    // Array extras
    if (!Array.prototype.indexOf) {
      Array.prototype.indexOf = function (needle, i) {
        var len;

        if (i === undefined) {
          i = 0;
        }

        if (i < 0) {
          i += this.length;
        }

        if (i < 0) {
          i = 0;
        }

        for (len = this.length; i < len; i++) {
          if (this.hasOwnProperty(i) && this[i] === needle) {
            return i;
          }
        }

        return -1;
      };
    }

    if (!Array.prototype.forEach) {
      Array.prototype.forEach = function (callback, context) {
        var i, len;

        for (i = 0, len = this.length; i < len; i += 1) {
          if (this.hasOwnProperty(i)) {
            callback.call(context, this[i], i, this);
          }
        }
      };
    }

    if (!Array.prototype.map) {
      Array.prototype.map = function (mapper, context) {
        var array = this,
            i,
            len,
            mapped = [],
            isActuallyString;

        // incredibly, if you do something like
        // Array.prototype.map.call( someString, iterator )
        // then `this` will become an instance of String in IE8.
        // And in IE8, you then can't do string[i]. Facepalm.
        if (array instanceof String) {
          array = array.toString();
          isActuallyString = true;
        }

        for (i = 0, len = array.length; i < len; i += 1) {
          if (array.hasOwnProperty(i) || isActuallyString) {
            mapped[i] = mapper.call(context, array[i], i, array);
          }
        }

        return mapped;
      };
    }

    if (typeof Array.prototype.reduce !== "function") {
      Array.prototype.reduce = function (callback, opt_initialValue) {
        var i, value, len, valueIsSet;

        if ("function" !== typeof callback) {
          throw new TypeError(callback + " is not a function");
        }

        len = this.length;
        valueIsSet = false;

        if (arguments.length > 1) {
          value = opt_initialValue;
          valueIsSet = true;
        }

        for (i = 0; i < len; i += 1) {
          if (this.hasOwnProperty(i)) {
            if (valueIsSet) {
              value = callback(value, this[i], i, this);
            }
          } else {
            value = this[i];
            valueIsSet = true;
          }
        }

        if (!valueIsSet) {
          throw new TypeError("Reduce of empty array with no initial value");
        }

        return value;
      };
    }

    if (!Array.prototype.filter) {
      Array.prototype.filter = function (filter, context) {
        var i,
            len,
            filtered = [];

        for (i = 0, len = this.length; i < len; i += 1) {
          if (this.hasOwnProperty(i) && filter.call(context, this[i], i, this)) {
            filtered[filtered.length] = this[i];
          }
        }

        return filtered;
      };
    }

    if (!Array.prototype.every) {
      Array.prototype.every = function (iterator, context) {
        var t, len, i;

        if (this == null) {
          throw new TypeError();
        }

        t = Object(this);
        len = t.length >>> 0;

        if (typeof iterator !== "function") {
          throw new TypeError();
        }

        for (i = 0; i < len; i += 1) {
          if (i in t && !iterator.call(context, t[i], i, t)) {
            return false;
          }
        }

        return true;
      };
    }

    /*
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/find
    if (!Array.prototype.find) {
    	Array.prototype.find = function(predicate) {
    		if (this == null) {
    		throw new TypeError('Array.prototype.find called on null or undefined');
    		}
    		if (typeof predicate !== 'function') {
    		throw new TypeError('predicate must be a function');
    		}
    		var list = Object(this);
    		var length = list.length >>> 0;
    		var thisArg = arguments[1];
    		var value;
    			for (var i = 0; i < length; i++) {
    			if (i in list) {
    				value = list[i];
    				if (predicate.call(thisArg, value, i, list)) {
    				return value;
    				}
    			}
    		}
    		return undefined;
    	}
    }
    */

    if (typeof Function.prototype.bind !== "function") {
      Function.prototype.bind = function (context) {
        var args,
            fn,
            Empty,
            bound,
            slice = [].slice;

        if (typeof this !== "function") {
          throw new TypeError("Function.prototype.bind called on non-function");
        }

        args = slice.call(arguments, 1);
        fn = this;
        Empty = function () {};

        bound = function () {
          var ctx = this instanceof Empty && context ? this : context;
          return fn.apply(ctx, args.concat(slice.call(arguments)));
        };

        Empty.prototype = this.prototype;
        bound.prototype = new Empty();

        return bound;
      };
    }

    // https://gist.github.com/Rich-Harris/6010282 via https://gist.github.com/jonathantneal/2869388
    // addEventListener polyfill IE6+
    if (!win.addEventListener) {
      (function (win, doc) {
        var Event, addEventListener, removeEventListener, head, style, origCreateElement;

        // because sometimes inquiring minds want to know
        win.appearsToBeIELessEqual8 = true;

        Event = function (e, element) {
          var property,
              instance = this;

          for (property in e) {
            instance[property] = e[property];
          }

          instance.currentTarget = element;
          instance.target = e.srcElement || element;
          instance.timeStamp = +new Date();

          instance.preventDefault = function () {
            e.returnValue = false;
          };

          instance.stopPropagation = function () {
            e.cancelBubble = true;
          };
        };

        addEventListener = function (type, listener) {
          var element = this,
              listeners,
              i;

          listeners = element.listeners || (element.listeners = []);
          i = listeners.length;

          listeners[i] = [listener, function (e) {
            listener.call(element, new Event(e, element));
          }];

          element.attachEvent("on" + type, listeners[i][1]);
        };

        removeEventListener = function (type, listener) {
          var element = this,
              listeners,
              i;

          if (!element.listeners) {
            return;
          }

          listeners = element.listeners;
          i = listeners.length;

          while (i--) {
            if (listeners[i][0] === listener) {
              element.detachEvent("on" + type, listeners[i][1]);
            }
          }
        };

        win.addEventListener = doc.addEventListener = addEventListener;
        win.removeEventListener = doc.removeEventListener = removeEventListener;

        if ("Element" in win) {
          win.Element.prototype.addEventListener = addEventListener;
          win.Element.prototype.removeEventListener = removeEventListener;
        } else {
          // First, intercept any calls to document.createElement - this is necessary
          // because the CSS hack (see below) doesn't come into play until after a
          // node is added to the DOM, which is too late for a lot of Ractive setup work
          origCreateElement = doc.createElement;

          doc.createElement = function (tagName) {
            var el = origCreateElement(tagName);
            el.addEventListener = addEventListener;
            el.removeEventListener = removeEventListener;
            return el;
          };

          // Then, mop up any additional elements that weren't created via
          // document.createElement (i.e. with innerHTML).
          head = doc.getElementsByTagName("head")[0];
          style = doc.createElement("style");

          head.insertBefore(style, head.firstChild);

          //style.styleSheet.cssText = '*{-ms-event-prototype:expression(!this.addEventListener&&(this.addEventListener=addEventListener)&&(this.removeEventListener=removeEventListener))}';
        }
      })(win, doc);
    }

    // The getComputedStyle polyfill interacts badly with jQuery, so we don't attach
    // it to window. Instead, we export it for other modules to use as needed

    // https://github.com/jonathantneal/Polyfills-for-IE8/blob/master/getComputedStyle.js
    if (!win.getComputedStyle) {
      exportedShims.getComputedStyle = (function () {
        var getPixelSize = function (element, style, property, fontSize) {
          var sizeWithSuffix = style[property],
              size = parseFloat(sizeWithSuffix),
              suffix = sizeWithSuffix.split(/\d/)[0],
              rootSize;

          if (isNaN(size)) {
            if (/^thin|medium|thick$/.test(sizeWithSuffix)) {
              size = getBorderPixelSize(sizeWithSuffix);
              suffix = "";
            } else {}
          }

          fontSize = fontSize != null ? fontSize : /%|em/.test(suffix) && element.parentElement ? getPixelSize(element.parentElement, element.parentElement.currentStyle, "fontSize", null) : 16;
          rootSize = property == "fontSize" ? fontSize : /width/i.test(property) ? element.clientWidth : element.clientHeight;

          return suffix == "em" ? size * fontSize : suffix == "in" ? size * 96 : suffix == "pt" ? size * 96 / 72 : suffix == "%" ? size / 100 * rootSize : size;
        };

        var getBorderPixelSize = function (size) {
          var div, bcr;

          // `thin`, `medium` and `thick` vary between browsers. (Don't ever use them.)
          if (!borderSizes[size]) {
            div = document.createElement("div");
            div.style.display = "block";
            div.style.position = "fixed";
            div.style.width = div.style.height = "0";
            div.style.borderRight = size + " solid black";

            document.getElementsByTagName("body")[0].appendChild(div);
            bcr = div.getBoundingClientRect();

            borderSizes[size] = bcr.right - bcr.left;
          }

          return borderSizes[size];
        };

        var setShortStyleProperty = function (style, property) {
          var borderSuffix = property == "border" ? "Width" : "",
              t = property + "Top" + borderSuffix,
              r = property + "Right" + borderSuffix,
              b = property + "Bottom" + borderSuffix,
              l = property + "Left" + borderSuffix;

          style[property] = (style[t] == style[r] == style[b] == style[l] ? [style[t]] : style[t] == style[b] && style[l] == style[r] ? [style[t], style[r]] : style[l] == style[r] ? [style[t], style[r], style[b]] : [style[t], style[r], style[b], style[l]]).join(" ");
        };

        var CSSStyleDeclaration = function (element) {
          var currentStyle, style, fontSize, property;

          currentStyle = element.currentStyle;
          style = this;
          fontSize = getPixelSize(element, currentStyle, "fontSize", null);

          // TODO tidy this up, test it, send PR to jonathantneal!
          for (property in currentStyle) {
            if (/width|height|margin.|padding.|border.+W/.test(property)) {
              if (currentStyle[property] === "auto") {
                if (/^width|height/.test(property)) {
                  // just use clientWidth/clientHeight...
                  style[property] = (property === "width" ? element.clientWidth : element.clientHeight) + "px";
                } else if (/(?:padding)?Top|Bottom$/.test(property)) {
                  style[property] = "0px";
                }
              } else {
                style[property] = getPixelSize(element, currentStyle, property, fontSize) + "px";
              }
            } else if (property === "styleFloat") {
              style.float = currentStyle[property];
            } else {
              style[property] = currentStyle[property];
            }
          }

          setShortStyleProperty(style, "margin");
          setShortStyleProperty(style, "padding");
          setShortStyleProperty(style, "border");

          style.fontSize = fontSize + "px";

          return style;
        };

        var getComputedStyle = function (element) {
          return new CSSStyleDeclaration(element);
        };

        var borderSizes = {};

        CSSStyleDeclaration.prototype = {
          constructor: CSSStyleDeclaration,
          getPropertyPriority: function () {},
          getPropertyValue: function (prop) {
            return this[prop] || "";
          },
          item: function () {},
          removeProperty: function () {},
          setProperty: function () {},
          getPropertyCSSValue: function () {}
        };

        return getComputedStyle;
      })();
    }
  }

  var legacy = exportedShims;
  // TODO...
  //# sourceMappingURL=02-6to5-legacy.js.map

  var create, defineProperty, defineProperties;

  try {
    Object.defineProperty({}, "test", { value: 0 });

    if (isClient) {
      Object.defineProperty(document.createElement("div"), "test", { value: 0 });
    }

    defineProperty = Object.defineProperty;
  } catch (err) {
    // Object.defineProperty doesn't exist, or we're in IE8 where you can
    // only use it with DOM objects (what were you smoking, MSFT?)
    defineProperty = function (obj, prop, desc) {
      obj[prop] = desc.value;
    };
  }

  try {
    try {
      Object.defineProperties({}, { test: { value: 0 } });
    } catch (err) {
      // TODO how do we account for this? noMagic = true;
      throw err;
    }

    if (isClient) {
      Object.defineProperties(createElement("div"), { test: { value: 0 } });
    }

    defineProperties = Object.defineProperties;
  } catch (err) {
    defineProperties = function (obj, props) {
      var prop;

      for (prop in props) {
        if (props.hasOwnProperty(prop)) {
          defineProperty(obj, prop, props[prop]);
        }
      }
    };
  }

  try {
    Object.create(null);

    create = Object.create;
  } catch (err) {
    // sigh
    create = (function () {
      var F = function () {};

      return function (proto, props) {
        var obj;

        if (proto === null) {
          return {};
        }

        F.prototype = proto;
        obj = new F();

        if (props) {
          Object.defineProperties(obj, props);
        }

        return obj;
      };
    })();
  }

  function object__extend(target) {
    for (var _len = arguments.length, sources = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      sources[_key - 1] = arguments[_key];
    }

    var prop, source;

    while (source = sources.shift()) {
      for (prop in source) {
        if (source.hasOwnProperty(prop)) {
          target[prop] = source[prop];
        }
      }
    }

    return target;
  }

  function fillGaps(target) {
    for (var _len2 = arguments.length, sources = Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
      sources[_key2 - 1] = arguments[_key2];
    }

    sources.forEach(function (s) {
      for (var key in s) {
        if (s.hasOwnProperty(key) && !(key in target)) {
          target[key] = s[key];
        }
      }
    });

    return target;
  }

  var hasOwn = Object.prototype.hasOwnProperty;
  //# sourceMappingURL=02-6to5-object.js.map

  var is__toString = Object.prototype.toString,
      arrayLikePattern = /^\[object (?:Array|FileList)\]$/;

  // thanks, http://perfectionkills.com/instanceof-considered-harmful-or-how-to-write-a-robust-isarray/
  function isArray(thing) {
    return is__toString.call(thing) === "[object Array]";
  }

  function isArrayLike(obj) {
    return arrayLikePattern.test(is__toString.call(obj));
  }

  function isEmptyObject(obj) {
    // if it's not an object, it's not an empty object
    if (!isObject(obj)) {
      return false;
    }

    for (var k in obj) {
      if (obj.hasOwnProperty(k)) return false;
    }

    return true;
  }

  function isEqual(a, b) {
    if (a === null && b === null) {
      return true;
    }

    if (typeof a === "object" || typeof b === "object") {
      return false;
    }

    return a === b;
  }

  function isNumber(thing) {
    return typeof thing === "number" || typeof thing === "object" && is__toString.call(thing) === "[object Number]";
  }

  // http://stackoverflow.com/questions/18082/validate-numbers-in-javascript-isnumeric
  function is__isNumeric(thing) {
    return !isNaN(parseFloat(thing)) && isFinite(thing);
  }

  function isObject(thing) {
    return thing && is__toString.call(thing) === "[object Object]";
  }

  function isFunction(thing) {
    return typeof thing === "function";
  }
  //# sourceMappingURL=02-6to5-is.js.map

  var noop = function () {};
  //# sourceMappingURL=02-6to5-noop.js.map

  /* global console */
  var alreadyWarned = {},
      log,
      printWarning;

  if (hasConsole) {
    printWarning = function (message, args) {
      console.warn.apply(console, ["%cRactive.js: %c" + message, "color: rgb(114, 157, 52);", "color: rgb(85, 85, 85);"].concat(args));
    };

    log = function () {
      console.log.apply(console, arguments);
    };
  } else {
    printWarning = log = noop;
  }

  function format(message, args) {
    return message.replace(/%s/g, function () {
      return args.shift();
    });
  }

  function consoleError(err) {
    if (hasConsole) {
      console.error(err);
    } else {
      throw err;
    }
  }

  function fatal(message) {
    for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      args[_key - 1] = arguments[_key];
    }

    message = format(message, args);
    throw new Error(message);
  }

  function warn(message) {
    for (var _len2 = arguments.length, args = Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
      args[_key2 - 1] = arguments[_key2];
    }

    message = format(message, args);
    printWarning(message, args);
  }

  function warnOnce(message) {
    for (var _len3 = arguments.length, args = Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1; _key3 < _len3; _key3++) {
      args[_key3 - 1] = arguments[_key3];
    }

    message = format(message, args);

    if (alreadyWarned[message]) {
      return;
    }

    alreadyWarned[message] = true;
    printWarning(message, args);
  }
  //# sourceMappingURL=02-6to5-log.js.map

  // Error messages that are used (or could be) in multiple places
  var badArguments = "Bad arguments";
  var noRegistryFunctionReturn = "A function was specified for \"%s\" %s, but no %s was returned";
  var missingPlugin = function (name, type) {
    return "Missing \"" + name + "\" " + type + " plugin. You may need to download a plugin via http://docs.ractivejs.org/latest/plugins#" + type + "s";
  };
  //# sourceMappingURL=02-6to5-errors.js.map

  function findInViewHierarchy(registryName, ractive, name) {
    var instance = findInstance(registryName, ractive, name);
    return instance ? instance[registryName][name] : null;
  }

  function findInstance(registryName, ractive, name) {
    while (ractive) {
      if (name in ractive[registryName]) {
        return ractive;
      }

      if (ractive.isolated) {
        return null;
      }

      ractive = ractive.parent;
    }
  }
  //# sourceMappingURL=02-6to5-registry.js.map

  var interpolate = function (from, to, ractive, type) {
    if (from === to) {
      return snap(to);
    }

    if (type) {
      var interpol = findInViewHierarchy("interpolators", ractive, type);
      if (interpol) {
        return interpol(from, to) || snap(to);
      }

      warnOnce(missingPlugin(type, "interpolator"));
    }

    return interpolators.number(from, to) || interpolators.array(from, to) || interpolators.object(from, to) || snap(to);
  };



  function snap(to) {
    return function () {
      return to;
    };
  }
  //# sourceMappingURL=02-6to5-interpolate.js.map

  var interpolators = {
    number: function (from, to) {
      var delta;

      if (!is__isNumeric(from) || !is__isNumeric(to)) {
        return null;
      }

      from = +from;
      to = +to;

      delta = to - from;

      if (!delta) {
        return function () {
          return from;
        };
      }

      return function (t) {
        return from + t * delta;
      };
    },

    array: function (from, to) {
      var intermediate, interpolators, len, i;

      if (!isArray(from) || !isArray(to)) {
        return null;
      }

      intermediate = [];
      interpolators = [];

      i = len = Math.min(from.length, to.length);
      while (i--) {
        interpolators[i] = interpolate(from[i], to[i]);
      }

      // surplus values - don't interpolate, but don't exclude them either
      for (i = len; i < from.length; i += 1) {
        intermediate[i] = from[i];
      }

      for (i = len; i < to.length; i += 1) {
        intermediate[i] = to[i];
      }

      return function (t) {
        var i = len;

        while (i--) {
          intermediate[i] = interpolators[i](t);
        }

        return intermediate;
      };
    },

    object: function (from, to) {
      var properties, len, interpolators, intermediate, prop;

      if (!isObject(from) || !isObject(to)) {
        return null;
      }

      properties = [];
      intermediate = {};
      interpolators = {};

      for (prop in from) {
        if (hasOwn.call(from, prop)) {
          if (hasOwn.call(to, prop)) {
            properties.push(prop);
            interpolators[prop] = interpolate(from[prop], to[prop]);
          } else {
            intermediate[prop] = from[prop];
          }
        }
      }

      for (prop in to) {
        if (hasOwn.call(to, prop) && !hasOwn.call(from, prop)) {
          intermediate[prop] = to[prop];
        }
      }

      len = properties.length;

      return function (t) {
        var i = len,
            prop;

        while (i--) {
          prop = properties[i];

          intermediate[prop] = interpolators[prop](t);
        }

        return intermediate;
      };
    }
  };


  //# sourceMappingURL=02-6to5-interpolators.js.map

  function add(root, keypath, d) {
    var value;

    if (typeof keypath !== "string" || !is__isNumeric(d)) {
      throw new Error("Bad arguments");
    }

    value = +root.get(keypath) || 0;

    if (!is__isNumeric(value)) {
      throw new Error("Cannot add to a non-numeric value");
    }

    return root.set(keypath, value + d);
  }
  //# sourceMappingURL=02-6to5-add.js.map

  function Ractive$add(keypath, d) {
    return add(this, keypath, d === undefined ? 1 : +d);
  }
  //# sourceMappingURL=02-6to5-add.js.map

  var requestAnimationFrame;

  // If window doesn't exist, we don't need requestAnimationFrame
  if (typeof window === "undefined") {
    requestAnimationFrame = null;
  } else {
    // https://gist.github.com/paulirish/1579671
    (function (vendors, lastTime, window) {
      var x, setTimeout;

      if (window.requestAnimationFrame) {
        return;
      }

      for (x = 0; x < vendors.length && !window.requestAnimationFrame; ++x) {
        window.requestAnimationFrame = window[vendors[x] + "RequestAnimationFrame"];
      }

      if (!window.requestAnimationFrame) {
        setTimeout = window.setTimeout;

        window.requestAnimationFrame = function (callback) {
          var currTime, timeToCall, id;

          currTime = Date.now();
          timeToCall = Math.max(0, 16 - (currTime - lastTime));
          id = setTimeout(function () {
            callback(currTime + timeToCall);
          }, timeToCall);

          lastTime = currTime + timeToCall;
          return id;
        };
      }
    })(vendors, 0, window);

    requestAnimationFrame = window.requestAnimationFrame;
  }

  var rAF = requestAnimationFrame;
  //# sourceMappingURL=02-6to5-requestAnimationFrame.js.map

  var getTime;

  if (typeof window !== "undefined" && window.performance && typeof window.performance.now === "function") {
    getTime = function () {
      return window.performance.now();
    };
  } else {
    getTime = function () {
      return Date.now();
    };
  }


  //# sourceMappingURL=02-6to5-getTime.js.map

  var deprecations = {
    construct: {
      deprecated: "beforeInit",
      replacement: "onconstruct"
    },
    render: {
      deprecated: "init",
      message: "The \"init\" method has been deprecated " + "and will likely be removed in a future release. " + "You can either use the \"oninit\" method which will fire " + "only once prior to, and regardless of, any eventual ractive " + "instance being rendered, or if you need to access the " + "rendered DOM, use \"onrender\" instead. " + "See http://docs.ractivejs.org/latest/migrating for more information."
    },
    complete: {
      deprecated: "complete",
      replacement: "oncomplete"
    }
  };

  function Hook(event) {
    this.event = event;
    this.method = "on" + event;
    this.deprecate = deprecations[event];
  }

  Hook.prototype.fire = function (ractive, arg) {
    var call = function (method) {
      if (ractive[method]) {
        arg ? ractive[method](arg) : ractive[method]();
        return true;
      }
    };

    call(this.method);

    if (!ractive[this.method] && this.deprecate && call(this.deprecate.deprecated)) {
      if (this.deprecate.message) {
        warn(this.deprecate.message);
      } else {
        warn("The method \"%s\" has been deprecated in favor of \"%s\" and will likely be removed in a future release. See http://docs.ractivejs.org/latest/migrating for more information.", this.deprecate.deprecated, this.deprecate.replacement);
      }
    }

    arg ? ractive.fire(this.event, arg) : ractive.fire(this.event);
  };


  //# sourceMappingURL=02-6to5-Hook.js.map

  function addToArray(array, value) {
    var index = array.indexOf(value);

    if (index === -1) {
      array.push(value);
    }
  }

  function arrayContains(array, value) {
    for (var i = 0, c = array.length; i < c; i++) {
      if (array[i] == value) {
        return true;
      }
    }

    return false;
  }

  function arrayContentsMatch(a, b) {
    var i;

    if (!isArray(a) || !isArray(b)) {
      return false;
    }

    if (a.length !== b.length) {
      return false;
    }

    i = a.length;
    while (i--) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  }

  function ensureArray(x) {
    if (typeof x === "string") {
      return [x];
    }

    if (x === undefined) {
      return [];
    }

    return x;
  }

  function lastItem(array) {
    return array[array.length - 1];
  }

  function removeFromArray(array, member) {
    var index = array.indexOf(member);

    if (index !== -1) {
      array.splice(index, 1);
    }
  }

  function toArray(arrayLike) {
    var array = [],
        i = arrayLike.length;
    while (i--) {
      array[i] = arrayLike[i];
    }

    return array;
  }
  //# sourceMappingURL=02-6to5-array.js.map

  var _Promise,
      PENDING = {},
      FULFILLED = {},
      REJECTED = {};

  if (typeof Promise === "function") {
    // use native Promise
    _Promise = Promise;
  } else {
    _Promise = function (callback) {
      var fulfilledHandlers = [],
          rejectedHandlers = [],
          state = PENDING,
          result,
          dispatchHandlers,
          makeResolver,
          fulfil,
          reject,
          promise;

      makeResolver = function (newState) {
        return function (value) {
          if (state !== PENDING) {
            return;
          }

          result = value;
          state = newState;

          dispatchHandlers = makeDispatcher(state === FULFILLED ? fulfilledHandlers : rejectedHandlers, result);

          // dispatch onFulfilled and onRejected handlers asynchronously
          wait(dispatchHandlers);
        };
      };

      fulfil = makeResolver(FULFILLED);
      reject = makeResolver(REJECTED);

      try {
        callback(fulfil, reject);
      } catch (err) {
        reject(err);
      }

      promise = {
        // `then()` returns a Promise - 2.2.7
        then: function (onFulfilled, onRejected) {
          var promise2 = new _Promise(function (fulfil, reject) {
            var processResolutionHandler = function (handler, handlers, forward) {
              // 2.2.1.1
              if (typeof handler === "function") {
                handlers.push(function (p1result) {
                  var x;

                  try {
                    x = handler(p1result);
                    utils_Promise__resolve(promise2, x, fulfil, reject);
                  } catch (err) {
                    reject(err);
                  }
                });
              } else {
                // Forward the result of promise1 to promise2, if resolution handlers
                // are not given
                handlers.push(forward);
              }
            };

            // 2.2
            processResolutionHandler(onFulfilled, fulfilledHandlers, fulfil);
            processResolutionHandler(onRejected, rejectedHandlers, reject);

            if (state !== PENDING) {
              // If the promise has resolved already, dispatch the appropriate handlers asynchronously
              wait(dispatchHandlers);
            }
          });

          return promise2;
        }
      };

      promise["catch"] = function (onRejected) {
        return this.then(null, onRejected);
      };

      return promise;
    };

    _Promise.all = function (promises) {
      return new _Promise(function (fulfil, reject) {
        var result = [],
            pending,
            i,
            processPromise;

        if (!promises.length) {
          fulfil(result);
          return;
        }

        processPromise = function (i) {
          promises[i].then(function (value) {
            result[i] = value;

            if (! --pending) {
              fulfil(result);
            }
          }, reject);
        };

        pending = i = promises.length;
        while (i--) {
          processPromise(i);
        }
      });
    };

    _Promise.resolve = function (value) {
      return new _Promise(function (fulfil) {
        fulfil(value);
      });
    };

    _Promise.reject = function (reason) {
      return new _Promise(function (fulfil, reject) {
        reject(reason);
      });
    };
  }

  var utils_Promise = _Promise;

  // TODO use MutationObservers or something to simulate setImmediate
  function wait(callback) {
    setTimeout(callback, 0);
  }

  function makeDispatcher(handlers, result) {
    return function () {
      var handler;

      while (handler = handlers.shift()) {
        handler(result);
      }
    };
  }

  function utils_Promise__resolve(promise, x, fulfil, reject) {
    // Promise Resolution Procedure
    var then;

    // 2.3.1
    if (x === promise) {
      throw new TypeError("A promise's fulfillment handler cannot return the same promise");
    }

    // 2.3.2
    if (x instanceof _Promise) {
      x.then(fulfil, reject);
    }

    // 2.3.3
    else if (x && (typeof x === "object" || typeof x === "function")) {
      try {
        then = x.then; // 2.3.3.1
      } catch (e) {
        reject(e); // 2.3.3.2
        return;
      }

      // 2.3.3.3
      if (typeof then === "function") {
        var called, resolvePromise, rejectPromise;

        resolvePromise = function (y) {
          if (called) {
            return;
          }
          called = true;
          utils_Promise__resolve(promise, y, fulfil, reject);
        };

        rejectPromise = function (r) {
          if (called) {
            return;
          }
          called = true;
          reject(r);
        };

        try {
          then.call(x, resolvePromise, rejectPromise);
        } catch (e) {
          if (!called) {
            // 2.3.3.3.4.1
            reject(e); // 2.3.3.3.4.2
            called = true;
            return;
          }
        }
      } else {
        fulfil(x);
      }
    } else {
      fulfil(x);
    }
  }
  //# sourceMappingURL=02-6to5-Promise.js.map

  var starMaps = {};

  // This function takes a keypath such as 'foo.bar.baz', and returns
  // all the variants of that keypath that include a wildcard in place
  // of a key, such as 'foo.bar.*', 'foo.*.baz', 'foo.*.*' and so on.
  // These are then checked against the dependants map (ractive.viewmodel.depsMap)
  // to see if any pattern observers are downstream of one or more of
  // these wildcard keypaths (e.g. 'foo.bar.*.status')
  function getPotentialWildcardMatches(keypath) {
    var keys, starMap, mapper, i, result, wildcardKeypath;

    keys = keypath.split(".");
    if (!(starMap = starMaps[keys.length])) {
      starMap = getStarMap(keys.length);
    }

    result = [];

    mapper = function (star, i) {
      return star ? "*" : keys[i];
    };

    i = starMap.length;
    while (i--) {
      wildcardKeypath = starMap[i].map(mapper).join(".");

      if (!result.hasOwnProperty(wildcardKeypath)) {
        result.push(wildcardKeypath);
        result[wildcardKeypath] = true;
      }
    }

    return result;
  }

  // This function returns all the possible true/false combinations for
  // a given number - e.g. for two, the possible combinations are
  // [ true, true ], [ true, false ], [ false, true ], [ false, false ].
  // It does so by getting all the binary values between 0 and e.g. 11
  function getStarMap(num) {
    var ones = "",
        max,
        binary,
        starMap,
        mapper,
        i;

    if (!starMaps[num]) {
      starMap = [];

      while (ones.length < num) {
        ones += 1;
      }

      max = parseInt(ones, 2);

      mapper = function (digit) {
        return digit === "1";
      };

      for (i = 0; i <= max; i += 1) {
        binary = i.toString(2);
        while (binary.length < num) {
          binary = "0" + binary;
        }

        starMap[i] = Array.prototype.map.call(binary, mapper);
      }

      starMaps[num] = starMap;
    }

    return starMaps[num];
  }
  //# sourceMappingURL=02-6to5-getPotentialWildcardMatches.js.map

  var refPattern, keypathCache, Keypath;

  refPattern = /\[\s*(\*|[0-9]|[1-9][0-9]+)\s*\]/g;

  keypathCache = {};

  Keypath = function (str) {
    var keys = str.split(".");

    this.str = str;

    if (str[0] === "@") {
      this.isSpecial = true;
      this.value = decodeKeypath(str);
    }

    this.firstKey = keys[0];
    this.lastKey = keys.pop();

    this.parent = str === "" ? null : getKeypath(keys.join("."));
    this.isRoot = !str;
  };

  Keypath.prototype = {
    equalsOrStartsWith: function equalsOrStartsWith(keypath) {
      return keypath === this || this.startsWith(keypath);
    },

    join: function join(str) {
      return getKeypath(this.isRoot ? String(str) : this.str + "." + str);
    },

    replace: function replace(oldKeypath, newKeypath) {
      if (this === oldKeypath) {
        return newKeypath;
      }

      if (this.startsWith(oldKeypath)) {
        return newKeypath === null ? newKeypath : getKeypath(this.str.replace(oldKeypath.str + ".", newKeypath.str + "."));
      }
    },

    startsWith: function startsWith(keypath) {
      if (!keypath) {
        // TODO under what circumstances does this happen?
        return false;
      }

      return keypath && this.str.substr(0, keypath.str.length + 1) === keypath.str + ".";
    },

    toString: function keypaths__toString() {
      throw new Error("Bad coercion");
    },

    valueOf: function valueOf() {
      throw new Error("Bad coercion");
    },

    wildcardMatches: function wildcardMatches() {
      return this._wildcardMatches || (this._wildcardMatches = getPotentialWildcardMatches(this.str));
    }
  };

  function assignNewKeypath(target, property, oldKeypath, newKeypath) {
    var existingKeypath = target[property];

    if (existingKeypath && (existingKeypath.equalsOrStartsWith(newKeypath) || !existingKeypath.equalsOrStartsWith(oldKeypath))) {
      return;
    }

    target[property] = existingKeypath ? existingKeypath.replace(oldKeypath, newKeypath) : newKeypath;
    return true;
  }

  function decodeKeypath(keypath) {
    var value = keypath.slice(2);

    if (keypath[1] === "i") {
      return is__isNumeric(value) ? +value : value;
    } else {
      return value;
    }
  }

  function getKeypath(str) {
    if (str == null) {
      return str;
    }

    // TODO it *may* be worth having two versions of this function - one where
    // keypathCache inherits from null, and one for IE8. Depends on how
    // much of an overhead hasOwnProperty is - probably negligible
    if (!keypathCache.hasOwnProperty(str)) {
      keypathCache[str] = new Keypath(str);
    }

    return keypathCache[str];
  }

  function getMatchingKeypaths(ractive, pattern) {
    var expand = function (matchingKeypaths, keypath) {
      var wrapper, value, key;

      wrapper = ractive.viewmodel.wrapped[keypath.str];
      value = wrapper ? wrapper.get() : ractive.viewmodel.get(keypath);

      for (key in value) {
        if (value.hasOwnProperty(key) && (key !== "_ractive" || !isArray(value))) {
          // for benefit of IE8
          matchingKeypaths.push(keypath.join(key));
        }
      }

      return matchingKeypaths;
    };

    var keys, key, matchingKeypaths;

    keys = pattern.split(".");
    matchingKeypaths = [rootKeypath];

    while (key = keys.shift()) {
      if (key === "*") {
        // expand to find all valid child keypaths
        matchingKeypaths = matchingKeypaths.reduce(expand, []);
      } else {
        if (matchingKeypaths[0] === rootKeypath) {
          // first key
          matchingKeypaths[0] = getKeypath(key);
        } else {
          matchingKeypaths = matchingKeypaths.map(concatenate(key));
        }
      }
    }

    return matchingKeypaths;
  }

  function concatenate(key) {
    return function (keypath) {
      return keypath.join(key);
    };
  }

  function normalise(ref) {
    return ref ? ref.replace(refPattern, ".$1") : "";
  }

  var rootKeypath = getKeypath("");
  //# sourceMappingURL=02-6to5-keypaths.js.map

  var getInnerContext = function (fragment) {
    do {
      if (fragment.context !== undefined) {
        return fragment.context;
      }
    } while (fragment = fragment.parent);

    return rootKeypath;
  };
  //# sourceMappingURL=02-6to5-getInnerContext.js.map

  function resolveRef(ractive, ref, fragment) {
    var keypath;

    ref = normalise(ref);

    // If a reference begins '~/', it's a top-level reference
    if (ref.substr(0, 2) === "~/") {
      keypath = getKeypath(ref.substring(2));
      createMappingIfNecessary(ractive, keypath.firstKey, fragment);
    }

    // If a reference begins with '.', it's either a restricted reference or
    // an ancestor reference...
    else if (ref[0] === ".") {
      keypath = resolveAncestorRef(getInnerContext(fragment), ref);

      if (keypath) {
        createMappingIfNecessary(ractive, keypath.firstKey, fragment);
      }
    }

    // ...otherwise we need to figure out the keypath based on context
    else {
      keypath = resolveAmbiguousReference(ractive, getKeypath(ref), fragment);
    }

    return keypath;
  }

  function resolveAncestorRef(baseContext, ref) {
    var contextKeys;

    // TODO...
    if (baseContext != undefined && typeof baseContext !== "string") {
      baseContext = baseContext.str;
    }

    // {{.}} means 'current context'
    if (ref === ".") return getKeypath(baseContext);

    contextKeys = baseContext ? baseContext.split(".") : [];

    // ancestor references (starting "../") go up the tree
    if (ref.substr(0, 3) === "../") {
      while (ref.substr(0, 3) === "../") {
        if (!contextKeys.length) {
          throw new Error("Could not resolve reference - too many \"../\" prefixes");
        }

        contextKeys.pop();
        ref = ref.substring(3);
      }

      contextKeys.push(ref);
      return getKeypath(contextKeys.join("."));
    }

    // not an ancestor reference - must be a restricted reference (prepended with "." or "./")
    if (!baseContext) {
      return getKeypath(ref.replace(/^\.\/?/, ""));
    }

    return getKeypath(baseContext + ref.replace(/^\.\//, "."));
  }

  function resolveAmbiguousReference(ractive, ref, fragment, isParentLookup) {
    var context, key, parentValue, hasContextChain, parentKeypath;

    if (ref.isRoot) {
      return ref;
    }

    key = ref.firstKey;

    while (fragment) {
      context = fragment.context;
      fragment = fragment.parent;

      if (!context) {
        continue;
      }

      hasContextChain = true;
      parentValue = ractive.viewmodel.get(context);

      if (parentValue && (typeof parentValue === "object" || typeof parentValue === "function") && key in parentValue) {
        return context.join(ref.str);
      }
    }

    // Root/computed/mapped property?
    if (isRootProperty(ractive, key)) {
      return ref;
    }

    // If this is an inline component, and it's not isolated, we
    // can try going up the scope chain
    if (ractive.parent && !ractive.isolated) {
      hasContextChain = true;
      fragment = ractive.component.parentFragment;

      key = getKeypath(key);

      if (parentKeypath = resolveAmbiguousReference(ractive.parent, key, fragment, true)) {
        // We need to create an inter-component binding
        ractive.viewmodel.map(key, {
          origin: ractive.parent.viewmodel,
          keypath: parentKeypath
        });

        return ref;
      }
    }

    // If there's no context chain, and the instance is either a) isolated or
    // b) an orphan, then we know that the keypath is identical to the reference
    if (!isParentLookup && !hasContextChain) {
      // the data object needs to have a property by this name,
      // to prevent future failed lookups
      ractive.viewmodel.set(ref, undefined);
      return ref;
    }
  }

  function createMappingIfNecessary(ractive, key) {
    var parentKeypath;

    if (!ractive.parent || ractive.isolated || isRootProperty(ractive, key)) {
      return;
    }

    key = getKeypath(key);

    if (parentKeypath = resolveAmbiguousReference(ractive.parent, key, ractive.component.parentFragment, true)) {
      ractive.viewmodel.map(key, {
        origin: ractive.parent.viewmodel,
        keypath: parentKeypath
      });
    }
  }

  function isRootProperty(ractive, key) {
    // special case for reference to root
    return key === "" || key in ractive.data || key in ractive.viewmodel.computations || key in ractive.viewmodel.mappings;
  }
  //# sourceMappingURL=02-6to5-resolveRef.js.map

  function teardown(x) {
    x.teardown();
  }
  function methodCallers__unbind(x) {
    x.unbind();
  }
  function methodCallers__unrender(x) {
    x.unrender();
  }
  //# sourceMappingURL=02-6to5-methodCallers.js.map

  var TransitionManager = function (callback, parent) {
    this.callback = callback;
    this.parent = parent;

    this.intros = [];
    this.outros = [];

    this.children = [];
    this.totalChildren = this.outroChildren = 0;

    this.detachQueue = [];
    this.decoratorQueue = [];
    this.outrosComplete = false;

    if (parent) {
      parent.addChild(this);
    }
  };

  TransitionManager.prototype = {
    addChild: function (child) {
      this.children.push(child);

      this.totalChildren += 1;
      this.outroChildren += 1;
    },

    decrementOutros: function () {
      this.outroChildren -= 1;
      check(this);
    },

    decrementTotal: function () {
      this.totalChildren -= 1;
      check(this);
    },

    add: function (transition) {
      var list = transition.isIntro ? this.intros : this.outros;
      list.push(transition);
    },

    addDecorator: function (decorator) {
      this.decoratorQueue.push(decorator);
    },

    remove: function (transition) {
      var list = transition.isIntro ? this.intros : this.outros;
      removeFromArray(list, transition);
      check(this);
    },

    init: function () {
      this.ready = true;
      check(this);
    },

    detachNodes: function () {
      this.decoratorQueue.forEach(teardown);
      this.detachQueue.forEach(TransitionManager__detach);
      this.children.forEach(detachNodes);
    }
  };

  function TransitionManager__detach(element) {
    element.detach();
  }

  function detachNodes(tm) {
    tm.detachNodes();
  }

  function check(tm) {
    if (!tm.ready || tm.outros.length || tm.outroChildren) return;

    // If all outros are complete, and we haven't already done this,
    // we notify the parent if there is one, otherwise
    // start detaching nodes
    if (!tm.outrosComplete) {
      if (tm.parent) {
        tm.parent.decrementOutros(tm);
      } else {
        tm.detachNodes();
      }

      tm.outrosComplete = true;
    }

    // Once everything is done, we can notify parent transition
    // manager and call the callback
    if (!tm.intros.length && !tm.totalChildren) {
      if (typeof tm.callback === "function") {
        tm.callback();
      }

      if (tm.parent) {
        tm.parent.decrementTotal();
      }
    }
  }


  //# sourceMappingURL=02-6to5-TransitionManager.js.map

  var batch,
      runloop,
      unresolved = [],
      changeHook = new Hook("change");

  runloop = {
    start: function (instance, returnPromise) {
      var promise, fulfilPromise;

      if (returnPromise) {
        promise = new utils_Promise(function (f) {
          return fulfilPromise = f;
        });
      }

      batch = {
        previousBatch: batch,
        transitionManager: new TransitionManager(fulfilPromise, batch && batch.transitionManager),
        views: [],
        tasks: [],
        viewmodels: [],
        instance: instance
      };

      if (instance) {
        batch.viewmodels.push(instance.viewmodel);
      }

      return promise;
    },

    end: function () {
      flushChanges();

      batch.transitionManager.init();
      if (!batch.previousBatch && !!batch.instance) batch.instance.viewmodel.changes = [];
      batch = batch.previousBatch;
    },

    addViewmodel: function (viewmodel) {
      if (batch) {
        if (batch.viewmodels.indexOf(viewmodel) === -1) {
          batch.viewmodels.push(viewmodel);
          return true;
        } else {
          return false;
        }
      } else {
        viewmodel.applyChanges();
        return false;
      }
    },

    registerTransition: function (transition) {
      transition._manager = batch.transitionManager;
      batch.transitionManager.add(transition);
    },

    registerDecorator: function (decorator) {
      batch.transitionManager.addDecorator(decorator);
    },

    addView: function (view) {
      batch.views.push(view);
    },

    addUnresolved: function (thing) {
      unresolved.push(thing);
    },

    removeUnresolved: function (thing) {
      removeFromArray(unresolved, thing);
    },

    // synchronise node detachments with transition ends
    detachWhenReady: function (thing) {
      batch.transitionManager.detachQueue.push(thing);
    },

    scheduleTask: function (task, postRender) {
      var _batch;

      if (!batch) {
        task();
      } else {
        _batch = batch;
        while (postRender && _batch.previousBatch) {
          // this can't happen until the DOM has been fully updated
          // otherwise in some situations (with components inside elements)
          // transitions and decorators will initialise prematurely
          _batch = _batch.previousBatch;
        }

        _batch.tasks.push(task);
      }
    }
  };



  function flushChanges() {
    var i, thing, changeHash;

    while (batch.viewmodels.length) {
      thing = batch.viewmodels.pop();
      changeHash = thing.applyChanges();

      if (changeHash) {
        changeHook.fire(thing.ractive, changeHash);
      }
    }

    attemptKeypathResolution();

    // Now that changes have been fully propagated, we can update the DOM
    // and complete other tasks
    for (i = 0; i < batch.views.length; i += 1) {
      batch.views[i].update();
    }
    batch.views.length = 0;

    for (i = 0; i < batch.tasks.length; i += 1) {
      batch.tasks[i]();
    }
    batch.tasks.length = 0;

    // If updating the view caused some model blowback - e.g. a triple
    // containing <option> elements caused the binding on the <select>
    // to update - then we start over
    if (batch.viewmodels.length) return flushChanges();
  }

  function attemptKeypathResolution() {
    var i, item, keypath, resolved;

    i = unresolved.length;

    // see if we can resolve any unresolved references
    while (i--) {
      item = unresolved[i];

      if (item.keypath) {
        // it resolved some other way. TODO how? two-way binding? Seems
        // weird that we'd still end up here
        unresolved.splice(i, 1);
        continue; // avoid removing the wrong thing should the next condition be true
      }

      if (keypath = resolveRef(item.root, item.ref, item.parentFragment)) {
        (resolved || (resolved = [])).push({
          item: item,
          keypath: keypath
        });

        unresolved.splice(i, 1);
      }
    }

    if (resolved) {
      resolved.forEach(runloop__resolve);
    }
  }

  function runloop__resolve(resolved) {
    resolved.item.resolve(resolved.keypath);
  }
  //# sourceMappingURL=02-6to5-runloop.js.map

  var queue = [];

  var animations = {
    tick: function () {
      var i, animation, now;

      now = getTime();

      runloop.start();

      for (i = 0; i < queue.length; i += 1) {
        animation = queue[i];

        if (!animation.tick(now)) {
          // animation is complete, remove it from the stack, and decrement i so we don't miss one
          queue.splice(i--, 1);
        }
      }

      runloop.end();

      if (queue.length) {
        rAF(animations.tick);
      } else {
        animations.running = false;
      }
    },

    add: function (animation) {
      queue.push(animation);

      if (!animations.running) {
        animations.running = true;
        rAF(animations.tick);
      }
    },

    // TODO optimise this
    abort: function (keypath, root) {
      var i = queue.length,
          animation;

      while (i--) {
        animation = queue[i];

        if (animation.root === root && animation.keypath === keypath) {
          animation.stop();
        }
      }
    }
  };

  var animations__default = animations;
  //# sourceMappingURL=02-6to5-animations.js.map

  var Animation = function (options) {
    var key;

    this.startTime = Date.now();

    // from and to
    for (key in options) {
      if (options.hasOwnProperty(key)) {
        this[key] = options[key];
      }
    }

    this.interpolator = interpolate(this.from, this.to, this.root, this.interpolator);
    this.running = true;

    this.tick();
  };

  Animation.prototype = {
    tick: function () {
      var elapsed, t, value, timeNow, index, keypath;

      keypath = this.keypath;

      if (this.running) {
        timeNow = Date.now();
        elapsed = timeNow - this.startTime;

        if (elapsed >= this.duration) {
          if (keypath !== null) {
            runloop.start(this.root);
            this.root.viewmodel.set(keypath, this.to);
            runloop.end();
          }

          if (this.step) {
            this.step(1, this.to);
          }

          this.complete(this.to);

          index = this.root._animations.indexOf(this);

          // TODO investigate why this happens
          if (index === -1) {
            warn("Animation was not found");
          }

          this.root._animations.splice(index, 1);

          this.running = false;
          return false; // remove from the stack
        }

        t = this.easing ? this.easing(elapsed / this.duration) : elapsed / this.duration;

        if (keypath !== null) {
          value = this.interpolator(t);
          runloop.start(this.root);
          this.root.viewmodel.set(keypath, value);
          runloop.end();
        }

        if (this.step) {
          this.step(t, value);
        }

        return true; // keep in the stack
      }

      return false; // remove from the stack
    },

    stop: function () {
      var index;

      this.running = false;

      index = this.root._animations.indexOf(this);

      // TODO investigate why this happens
      if (index === -1) {
        warn("Animation was not found");
      }

      this.root._animations.splice(index, 1);
    }
  };


  //# sourceMappingURL=02-6to5-Animation.js.map

  var noAnimation = { stop: noop };

  function Ractive$animate(keypath, to, options) {
    var promise, fulfilPromise, k, animation, animations, easing, duration, step, complete, makeValueCollector, currentValues, collectValue, dummy, dummyOptions;

    promise = new utils_Promise(function (fulfil) {
      fulfilPromise = fulfil;
    });

    // animate multiple keypaths
    if (typeof keypath === "object") {
      options = to || {};
      easing = options.easing;
      duration = options.duration;

      animations = [];

      // we don't want to pass the `step` and `complete` handlers, as they will
      // run for each animation! So instead we'll store the handlers and create
      // our own...
      step = options.step;
      complete = options.complete;

      if (step || complete) {
        currentValues = {};

        options.step = null;
        options.complete = null;

        makeValueCollector = function (keypath) {
          return function (t, value) {
            currentValues[keypath] = value;
          };
        };
      }


      for (k in keypath) {
        if (keypath.hasOwnProperty(k)) {
          if (step || complete) {
            collectValue = makeValueCollector(k);
            options = {
              easing: easing,
              duration: duration
            };

            if (step) {
              options.step = collectValue;
            }
          }

          options.complete = complete ? collectValue : noop;
          animations.push(animate(this, k, keypath[k], options));
        }
      }

      // Create a dummy animation, to facilitate step/complete
      // callbacks, and Promise fulfilment
      dummyOptions = {
        easing: easing,
        duration: duration
      };

      if (step) {
        dummyOptions.step = function (t) {
          step(t, currentValues);
        };
      }

      if (complete) {
        promise.then(function (t) {
          complete(t, currentValues);
        }).then(null, consoleError);
      }

      dummyOptions.complete = fulfilPromise;

      dummy = animate(this, null, null, dummyOptions);
      animations.push(dummy);

      promise.stop = function () {
        var animation;

        while (animation = animations.pop()) {
          animation.stop();
        }

        if (dummy) {
          dummy.stop();
        }
      };

      return promise;
    }

    // animate a single keypath
    options = options || {};

    if (options.complete) {
      promise.then(options.complete).then(null, consoleError);
    }

    options.complete = fulfilPromise;
    animation = animate(this, keypath, to, options);

    promise.stop = function () {
      animation.stop();
    };
    return promise;
  }

  function animate(root, keypath, to, options) {
    var easing, duration, animation, from;

    if (keypath) {
      keypath = getKeypath(normalise(keypath));
    }

    if (keypath !== null) {
      from = root.viewmodel.get(keypath);
    }

    // cancel any existing animation
    // TODO what about upstream/downstream keypaths?
    animations__default.abort(keypath, root);

    // don't bother animating values that stay the same
    if (isEqual(from, to)) {
      if (options.complete) {
        options.complete(options.to);
      }

      return noAnimation;
    }

    // easing function
    if (options.easing) {
      if (typeof options.easing === "function") {
        easing = options.easing;
      } else {
        easing = root.easing[options.easing];
      }

      if (typeof easing !== "function") {
        easing = null;
      }
    }

    // duration
    duration = options.duration === undefined ? 400 : options.duration;

    // TODO store keys, use an internal set method
    animation = new Animation({
      keypath: keypath,
      from: from,
      to: to,
      root: root,
      duration: duration,
      easing: easing,
      interpolator: options.interpolator,

      // TODO wrap callbacks if necessary, to use instance as context
      step: options.step,
      complete: options.complete
    });

    animations__default.add(animation);
    root._animations.push(animation);

    return animation;
  }
  //# sourceMappingURL=02-6to5-animate.js.map

  var prototype_detach__detachHook = new Hook("detach");

  function Ractive$detach() {
    if (this.detached) {
      return this.detached;
    }

    if (this.el) {
      removeFromArray(this.el.__ractive_instances__, this);
    }
    this.detached = this.fragment.detach();
    prototype_detach__detachHook.fire(this);
    return this.detached;
  }
  //# sourceMappingURL=02-6to5-detach.js.map

  function Ractive$find(selector) {
    if (!this.el) {
      return null;
    }

    return this.fragment.find(selector);
  }
  //# sourceMappingURL=02-6to5-find.js.map

  var test = function (item, noDirty) {
    var itemMatches;

    if (this._isComponentQuery) {
      itemMatches = !this.selector || item.name === this.selector;
    } else {
      itemMatches = item.node ? matches(item.node, this.selector) : null;
    }

    if (itemMatches) {
      this.push(item.node || item.instance);

      if (!noDirty) {
        this._makeDirty();
      }

      return true;
    }
  };
  //# sourceMappingURL=02-6to5-test.js.map

  var cancel = function () {
    var liveQueries, selector, index;

    liveQueries = this._root[this._isComponentQuery ? "liveComponentQueries" : "liveQueries"];
    selector = this.selector;

    index = liveQueries.indexOf(selector);

    if (index !== -1) {
      liveQueries.splice(index, 1);
      liveQueries[selector] = null;
    }
  };
  //# sourceMappingURL=02-6to5-cancel.js.map

  var sortByItemPosition = function (a, b) {
    var ancestryA, ancestryB, oldestA, oldestB, mutualAncestor, indexA, indexB, fragments, fragmentA, fragmentB;

    ancestryA = getAncestry(a.component || a._ractive.proxy);
    ancestryB = getAncestry(b.component || b._ractive.proxy);

    oldestA = lastItem(ancestryA);
    oldestB = lastItem(ancestryB);

    // remove items from the end of both ancestries as long as they are identical
    // - the final one removed is the closest mutual ancestor
    while (oldestA && oldestA === oldestB) {
      ancestryA.pop();
      ancestryB.pop();

      mutualAncestor = oldestA;

      oldestA = lastItem(ancestryA);
      oldestB = lastItem(ancestryB);
    }

    // now that we have the mutual ancestor, we can find which is earliest
    oldestA = oldestA.component || oldestA;
    oldestB = oldestB.component || oldestB;

    fragmentA = oldestA.parentFragment;
    fragmentB = oldestB.parentFragment;

    // if both items share a parent fragment, our job is easy
    if (fragmentA === fragmentB) {
      indexA = fragmentA.items.indexOf(oldestA);
      indexB = fragmentB.items.indexOf(oldestB);

      // if it's the same index, it means one contains the other,
      // so we see which has the longest ancestry
      return indexA - indexB || ancestryA.length - ancestryB.length;
    }

    // if mutual ancestor is a section, we first test to see which section
    // fragment comes first
    if (fragments = mutualAncestor.fragments) {
      indexA = fragments.indexOf(fragmentA);
      indexB = fragments.indexOf(fragmentB);

      return indexA - indexB || ancestryA.length - ancestryB.length;
    }

    throw new Error("An unexpected condition was met while comparing the position of two components. Please file an issue at https://github.com/RactiveJS/Ractive/issues - thanks!");
  };

  function getParent(item) {
    var parentFragment;

    if (parentFragment = item.parentFragment) {
      return parentFragment.owner;
    }

    if (item.component && (parentFragment = item.component.parentFragment)) {
      return parentFragment.owner;
    }
  }

  function getAncestry(item) {
    var ancestry, ancestor;

    ancestry = [item];

    ancestor = getParent(item);

    while (ancestor) {
      ancestry.push(ancestor);
      ancestor = getParent(ancestor);
    }

    return ancestry;
  }
  //# sourceMappingURL=02-6to5-sortByItemPosition.js.map

  var sortByDocumentPosition = function (node, otherNode) {
    var bitmask;

    if (node.compareDocumentPosition) {
      bitmask = node.compareDocumentPosition(otherNode);
      return bitmask & 2 ? 1 : -1;
    }

    // In old IE, we can piggy back on the mechanism for
    // comparing component positions
    return sortByItemPosition(node, otherNode);
  };
  //# sourceMappingURL=02-6to5-sortByDocumentPosition.js.map

  var sort = function () {
    this.sort(this._isComponentQuery ? sortByItemPosition : sortByDocumentPosition);
    this._dirty = false;
  };
  //# sourceMappingURL=02-6to5-sort.js.map

  var dirty = function () {
    var _this = this;
    if (!this._dirty) {
      this._dirty = true;

      // Once the DOM has been updated, ensure the query
      // is correctly ordered
      runloop.scheduleTask(function () {
        _this._sort();
      });
    }
  };
  //# sourceMappingURL=02-6to5-dirty.js.map

  var remove = function (nodeOrComponent) {
    var index = this.indexOf(this._isComponentQuery ? nodeOrComponent.instance : nodeOrComponent);

    if (index !== -1) {
      this.splice(index, 1);
    }
  };
  //# sourceMappingURL=02-6to5-remove.js.map

  function makeQuery(ractive, selector, live, isComponentQuery) {
    var query = [];

    defineProperties(query, {
      selector: { value: selector },
      live: { value: live },

      _isComponentQuery: { value: isComponentQuery },
      _test: { value: test }
    });

    if (!live) {
      return query;
    }

    defineProperties(query, {
      cancel: { value: cancel },

      _root: { value: ractive },
      _sort: { value: sort },
      _makeDirty: { value: dirty },
      _remove: { value: remove },

      _dirty: { value: false, writable: true }
    });

    return query;
  }
  //# sourceMappingURL=02-6to5-_makeQuery.js.map

  function Ractive$findAll(selector, options) {
    var liveQueries, query;

    if (!this.el) {
      return [];
    }

    options = options || {};
    liveQueries = this._liveQueries;

    // Shortcut: if we're maintaining a live query with this
    // selector, we don't need to traverse the parallel DOM
    if (query = liveQueries[selector]) {
      // Either return the exact same query, or (if not live) a snapshot
      return options && options.live ? query : query.slice();
    }

    query = makeQuery(this, selector, !!options.live, false);

    // Add this to the list of live queries Ractive needs to maintain,
    // if applicable
    if (query.live) {
      liveQueries.push(selector);
      liveQueries["_" + selector] = query;
    }

    this.fragment.findAll(selector, query);
    return query;
  }
  //# sourceMappingURL=02-6to5-findAll.js.map

  function Ractive$findAllComponents(selector, options) {
    var liveQueries, query;

    options = options || {};
    liveQueries = this._liveComponentQueries;

    // Shortcut: if we're maintaining a live query with this
    // selector, we don't need to traverse the parallel DOM
    if (query = liveQueries[selector]) {
      // Either return the exact same query, or (if not live) a snapshot
      return options && options.live ? query : query.slice();
    }

    query = makeQuery(this, selector, !!options.live, true);

    // Add this to the list of live queries Ractive needs to maintain,
    // if applicable
    if (query.live) {
      liveQueries.push(selector);
      liveQueries["_" + selector] = query;
    }

    this.fragment.findAllComponents(selector, query);
    return query;
  }
  //# sourceMappingURL=02-6to5-findAllComponents.js.map

  function Ractive$findComponent(selector) {
    return this.fragment.findComponent(selector);
  }
  //# sourceMappingURL=02-6to5-findComponent.js.map

  function Ractive$findContainer(selector) {
    if (this.container) {
      if (this.container.component && this.container.component.name === selector) {
        return this.container;
      } else {
        return this.container.findContainer(selector);
      }
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-findContainer.js.map

  function Ractive$findParent(selector) {
    if (this.parent) {
      if (this.parent.component && this.parent.component.name === selector) {
        return this.parent;
      } else {
        return this.parent.findParent(selector);
      }
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-findParent.js.map

  var eventStack = {
    enqueue: function (ractive, event) {
      if (ractive.event) {
        ractive._eventQueue = ractive._eventQueue || [];
        ractive._eventQueue.push(ractive.event);
      }
      ractive.event = event;
    },
    dequeue: function (ractive) {
      if (ractive._eventQueue && ractive._eventQueue.length) {
        ractive.event = ractive._eventQueue.pop();
      } else {
        delete ractive.event;
      }
    }
  };


  //# sourceMappingURL=02-6to5-eventStack.js.map

  function fireEvent(ractive, eventName) {
    var options = arguments[2] === undefined ? {} : arguments[2];
    if (!eventName) {
      return;
    }

    if (!options.event) {
      options.event = {
        name: eventName,
        context: ractive.data,
        keypath: "",
        // until event not included as argument default
        _noArg: true
      };
    } else {
      options.event.name = eventName;
    }

    var eventNames = getKeypath(eventName).wildcardMatches();
    fireEventAs(ractive, eventNames, options.event, options.args, true);
  }

  function fireEventAs(ractive, eventNames, event, args) {
    var initialFire = arguments[4] === undefined ? false : arguments[4];


    var subscribers,
        i,
        bubble = true;

    eventStack.enqueue(ractive, event);

    for (i = eventNames.length; i >= 0; i--) {
      subscribers = ractive._subs[eventNames[i]];

      if (subscribers) {
        bubble = notifySubscribers(ractive, subscribers, event, args) && bubble;
      }
    }

    eventStack.dequeue(ractive);

    if (ractive.parent && bubble) {
      if (initialFire && ractive.component) {
        var fullName = ractive.component.name + "." + eventNames[eventNames.length - 1];
        eventNames = getKeypath(fullName).wildcardMatches();

        if (event) {
          event.component = ractive;
        }
      }

      fireEventAs(ractive.parent, eventNames, event, args);
    }
  }

  function notifySubscribers(ractive, subscribers, event, args) {
    var originalEvent = null,
        stopEvent = false;

    if (event && !event._noArg) {
      args = [event].concat(args);
    }

    // subscribers can be modified inflight, e.g. "once" functionality
    // so we need to copy to make sure everyone gets called
    subscribers = subscribers.slice();

    for (var i = 0, len = subscribers.length; i < len; i += 1) {
      if (subscribers[i].apply(ractive, args) === false) {
        stopEvent = true;
      }
    }

    if (event && !event._noArg && stopEvent && (originalEvent = event.original)) {
      originalEvent.preventDefault && originalEvent.preventDefault();
      originalEvent.stopPropagation && originalEvent.stopPropagation();
    }

    return !stopEvent;
  }
  //# sourceMappingURL=02-6to5-fireEvent.js.map

  function Ractive$fire(eventName) {
    var options = {
      args: Array.prototype.slice.call(arguments, 1)
    };

    fireEvent(this, eventName, options);
  }
  //# sourceMappingURL=02-6to5-fire.js.map

  var options = {
    capture: true, // top-level calls should be intercepted
    noUnwrap: true // wrapped values should NOT be unwrapped
  };

  function Ractive$get(keypath) {
    var value;

    keypath = getKeypath(normalise(keypath));
    value = this.viewmodel.get(keypath, options);

    // Create inter-component binding, if necessary
    if (value === undefined && this.parent && !this.isolated) {
      if (resolveRef(this, keypath.str, this.component.parentFragment)) {
        // creates binding as side-effect, if appropriate
        value = this.viewmodel.get(keypath);
      }
    }

    return value;
  }
  //# sourceMappingURL=02-6to5-get.js.map

  var insertHook = new Hook("insert");

  function Ractive$insert(target, anchor) {
    if (!this.fragment.rendered) {
      // TODO create, and link to, documentation explaining this
      throw new Error("The API has changed - you must call `ractive.render(target[, anchor])` to render your Ractive instance. Once rendered you can use `ractive.insert()`.");
    }

    target = getElement(target);
    anchor = getElement(anchor) || null;

    if (!target) {
      throw new Error("You must specify a valid target to insert into");
    }

    target.insertBefore(this.detach(), anchor);
    this.el = target;

    (target.__ractive_instances__ || (target.__ractive_instances__ = [])).push(this);
    this.detached = null;

    fireInsertHook(this);
  }

  function fireInsertHook(ractive) {
    insertHook.fire(ractive);

    ractive.findAllComponents("*").forEach(function (child) {
      fireInsertHook(child.instance);
    });
  }
  //# sourceMappingURL=02-6to5-insert.js.map

  function Ractive$merge(keypath, array, options) {
    var currentArray, promise;

    keypath = getKeypath(normalise(keypath));
    currentArray = this.viewmodel.get(keypath);

    // If either the existing value or the new value isn't an
    // array, just do a regular set
    if (!isArray(currentArray) || !isArray(array)) {
      return this.set(keypath, array, options && options.complete);
    }

    // Manage transitions
    promise = runloop.start(this, true);
    this.viewmodel.merge(keypath, currentArray, array, options);
    runloop.end();

    return promise;
  }
  //# sourceMappingURL=02-6to5-merge.js.map

  var Observer = function (ractive, keypath, callback, options) {
    this.root = ractive;
    this.keypath = keypath;
    this.callback = callback;
    this.defer = options.defer;

    // default to root as context, but allow it to be overridden
    this.context = options && options.context ? options.context : ractive;
  };

  Observer.prototype = {
    init: function (immediate) {
      this.value = this.root.get(this.keypath.str);

      if (immediate !== false) {
        this.update();
      } else {
        this.oldValue = this.value;
      }
    },

    setValue: function (value) {
      var _this = this;
      if (!isEqual(value, this.value)) {
        this.value = value;

        if (this.defer && this.ready) {
          runloop.scheduleTask(function () {
            return _this.update();
          });
        } else {
          this.update();
        }
      }
    },

    update: function () {
      // Prevent infinite loops
      if (this.updating) {
        return;
      }

      this.updating = true;

      this.callback.call(this.context, this.value, this.oldValue, this.keypath.str);
      this.oldValue = this.value;

      this.updating = false;
    }
  };


  //# sourceMappingURL=02-6to5-Observer.js.map

  function getPattern(ractive, pattern) {
    var matchingKeypaths, values;

    matchingKeypaths = getMatchingKeypaths(ractive, pattern.str);

    values = {};
    matchingKeypaths.forEach(function (keypath) {
      values[keypath.str] = ractive.get(keypath.str);
    });

    return values;
  }
  //# sourceMappingURL=02-6to5-getPattern.js.map

  var PatternObserver,
      PatternObserver__wildcard = /\*/,
      slice = Array.prototype.slice;

  PatternObserver = function (ractive, keypath, callback, options) {
    this.root = ractive;

    this.callback = callback;
    this.defer = options.defer;

    this.keypath = keypath;
    this.regex = new RegExp("^" + keypath.str.replace(/\./g, "\\.").replace(/\*/g, "([^\\.]+)") + "$");
    this.values = {};

    if (this.defer) {
      this.proxies = [];
    }

    // default to root as context, but allow it to be overridden
    this.context = options && options.context ? options.context : ractive;
  };

  PatternObserver.prototype = {
    init: function (immediate) {
      var values, keypath;

      values = getPattern(this.root, this.keypath);

      if (immediate !== false) {
        for (keypath in values) {
          if (values.hasOwnProperty(keypath)) {
            this.update(getKeypath(keypath));
          }
        }
      } else {
        this.values = values;
      }
    },

    update: function (keypath) {
      var _this = this;
      var values;

      if (PatternObserver__wildcard.test(keypath.str)) {
        values = getPattern(this.root, keypath);

        for (keypath in values) {
          if (values.hasOwnProperty(keypath)) {
            this.update(getKeypath(keypath));
          }
        }

        return;
      }

      // special case - array mutation should not trigger `array.*`
      // pattern observer with `array.length`
      if (this.root.viewmodel.implicitChanges[keypath.str]) {
        return;
      }

      if (this.defer && this.ready) {
        runloop.scheduleTask(function () {
          return _this.getProxy(keypath).update();
        });
        return;
      }

      this.reallyUpdate(keypath);
    },

    reallyUpdate: function (keypath) {
      var keypathStr, value, keys, args;

      keypathStr = keypath.str;
      value = this.root.viewmodel.get(keypath);

      // Prevent infinite loops
      if (this.updating) {
        this.values[keypathStr] = value;
        return;
      }

      this.updating = true;

      if (!isEqual(value, this.values[keypathStr]) || !this.ready) {
        keys = slice.call(this.regex.exec(keypathStr), 1);
        args = [value, this.values[keypathStr], keypathStr].concat(keys);

        this.values[keypathStr] = value;
        this.callback.apply(this.context, args);
      }

      this.updating = false;
    },

    getProxy: function (keypath) {
      var _this2 = this;
      if (!this.proxies[keypath.str]) {
        this.proxies[keypath.str] = {
          update: function () {
            return _this2.reallyUpdate(keypath);
          }
        };
      }

      return this.proxies[keypath.str];
    }
  };


  //# sourceMappingURL=02-6to5-PatternObserver.js.map

  var getObserverFacade__wildcard = /\*/,
      emptyObject = {};

  function getObserverFacade(ractive, keypath, callback, options) {
    var observer, isPatternObserver, cancelled;

    keypath = getKeypath(normalise(keypath));
    options = options || emptyObject;

    // pattern observers are treated differently
    if (getObserverFacade__wildcard.test(keypath.str)) {
      observer = new PatternObserver(ractive, keypath, callback, options);
      ractive.viewmodel.patternObservers.push(observer);
      isPatternObserver = true;
    } else {
      observer = new Observer(ractive, keypath, callback, options);
    }

    observer.init(options.init);
    ractive.viewmodel.register(keypath, observer, isPatternObserver ? "patternObservers" : "observers");

    // This flag allows observers to initialise even with undefined values
    observer.ready = true;

    return {
      cancel: function () {
        var index;

        if (cancelled) {
          return;
        }

        if (isPatternObserver) {
          index = ractive.viewmodel.patternObservers.indexOf(observer);

          ractive.viewmodel.patternObservers.splice(index, 1);
          ractive.viewmodel.unregister(keypath, observer, "patternObservers");
        } else {
          ractive.viewmodel.unregister(keypath, observer, "observers");
        }
        cancelled = true;
      }
    };
  }
  //# sourceMappingURL=02-6to5-getObserverFacade.js.map

  function Ractive$observe(keypath, callback, options) {
    var observers, map, keypaths, i;

    // Allow a map of keypaths to handlers
    if (isObject(keypath)) {
      options = callback;
      map = keypath;

      observers = [];

      for (keypath in map) {
        if (map.hasOwnProperty(keypath)) {
          callback = map[keypath];
          observers.push(this.observe(keypath, callback, options));
        }
      }

      return {
        cancel: function () {
          while (observers.length) {
            observers.pop().cancel();
          }
        }
      };
    }

    // Allow `ractive.observe( callback )` - i.e. observe entire model
    if (typeof keypath === "function") {
      options = callback;
      callback = keypath;
      keypath = "";

      return getObserverFacade(this, keypath, callback, options);
    }

    keypaths = keypath.split(" ");

    // Single keypath
    if (keypaths.length === 1) {
      return getObserverFacade(this, keypath, callback, options);
    }

    // Multiple space-separated keypaths
    observers = [];

    i = keypaths.length;
    while (i--) {
      keypath = keypaths[i];

      if (keypath) {
        observers.push(getObserverFacade(this, keypath, callback, options));
      }
    }

    return {
      cancel: function () {
        while (observers.length) {
          observers.pop().cancel();
        }
      }
    };
  }
  //# sourceMappingURL=02-6to5-observe.js.map

  function Ractive$observeOnce(property, callback, options) {
    var observer = this.observe(property, function () {
      callback.apply(this, arguments);
      observer.cancel();
    }, { init: false, defer: options && options.defer });

    return observer;
  }
  //# sourceMappingURL=02-6to5-observeOnce.js.map

  var trim__default = function (str) {
    return str.trim();
  };
  //# sourceMappingURL=02-6to5-trim.js.map

  var notEmptyString = function (str) {
    return str !== "";
  };
  //# sourceMappingURL=02-6to5-notEmptyString.js.map

  function Ractive$off(eventName, callback) {
    var _this = this;
    var eventNames;

    // if no arguments specified, remove all callbacks
    if (!eventName) {
      // TODO use this code instead, once the following issue has been resolved
      // in PhantomJS (tests are unpassable otherwise!)
      // https://github.com/ariya/phantomjs/issues/11856
      // defineProperty( this, '_subs', { value: create( null ), configurable: true });
      for (eventName in this._subs) {
        delete this._subs[eventName];
      }
    } else {
      // Handle multiple space-separated event names
      eventNames = eventName.split(" ").map(trim__default).filter(notEmptyString);

      eventNames.forEach(function (eventName) {
        var subscribers, index;

        // If we have subscribers for this event...
        if (subscribers = _this._subs[eventName]) {
          // ...if a callback was specified, only remove that
          if (callback) {
            index = subscribers.indexOf(callback);
            if (index !== -1) {
              subscribers.splice(index, 1);
            }
          }

          // ...otherwise remove all callbacks
          else {
            _this._subs[eventName] = [];
          }
        }
      });
    }

    return this;
  }
  //# sourceMappingURL=02-6to5-off.js.map

  function Ractive$on(eventName, callback) {
    var _this = this;
    var listeners, n, eventNames;

    // allow mutliple listeners to be bound in one go
    if (typeof eventName === "object") {
      listeners = [];

      for (n in eventName) {
        if (eventName.hasOwnProperty(n)) {
          listeners.push(this.on(n, eventName[n]));
        }
      }

      return {
        cancel: function () {
          var listener;

          while (listener = listeners.pop()) {
            listener.cancel();
          }
        }
      };
    }

    // Handle multiple space-separated event names
    eventNames = eventName.split(" ").map(trim__default).filter(notEmptyString);

    eventNames.forEach(function (eventName) {
      (_this._subs[eventName] || (_this._subs[eventName] = [])).push(callback);
    });

    return {
      cancel: function () {
        return _this.off(eventName, callback);
      }
    };
  }
  //# sourceMappingURL=02-6to5-on.js.map

  function Ractive$once(eventName, handler) {
    var listener = this.on(eventName, function () {
      handler.apply(this, arguments);
      listener.cancel();
    });

    // so we can still do listener.cancel() manually
    return listener;
  }
  //# sourceMappingURL=02-6to5-once.js.map

  // This function takes an array, the name of a mutator method, and the
  // arguments to call that mutator method with, and returns an array that
  // maps the old indices to their new indices.

  // So if you had something like this...
  //
  //     array = [ 'a', 'b', 'c', 'd' ];
  //     array.push( 'e' );
  //
  // ...you'd get `[ 0, 1, 2, 3 ]` - in other words, none of the old indices
  // have changed. If you then did this...
  //
  //     array.unshift( 'z' );
  //
  // ...the indices would be `[ 1, 2, 3, 4, 5 ]` - every item has been moved
  // one higher to make room for the 'z'. If you removed an item, the new index
  // would be -1...
  //
  //     array.splice( 2, 2 );
  //
  // ...this would result in [ 0, 1, -1, -1, 2, 3 ].
  //
  // This information is used to enable fast, non-destructive shuffling of list
  // sections when you do e.g. `ractive.splice( 'items', 2, 2 );

  function getNewIndices(array, methodName, args) {
    var spliceArguments,
        len,
        newIndices = [],
        removeStart,
        removeEnd,
        balance,
        i;

    spliceArguments = getSpliceEquivalent(array, methodName, args);

    if (!spliceArguments) {
      return null; // TODO support reverse and sort?
    }

    len = array.length;
    balance = spliceArguments.length - 2 - spliceArguments[1];

    removeStart = Math.min(len, spliceArguments[0]);
    removeEnd = removeStart + spliceArguments[1];

    for (i = 0; i < removeStart; i += 1) {
      newIndices.push(i);
    }

    for (; i < removeEnd; i += 1) {
      newIndices.push(-1);
    }

    for (; i < len; i += 1) {
      newIndices.push(i + balance);
    }

    return newIndices;
  }


  // The pop, push, shift an unshift methods can all be represented
  // as an equivalent splice
  function getSpliceEquivalent(array, methodName, args) {
    switch (methodName) {
      case "splice":
        if (args[0] !== undefined && args[0] < 0) {
          args[0] = array.length + Math.max(args[0], -array.length);
        }

        while (args.length < 2) {
          args.push(0);
        }

        // ensure we only remove elements that exist
        args[1] = Math.min(args[1], array.length - args[0]);

        return args;

      case "sort":
      case "reverse":
        return null;

      case "pop":
        if (array.length) {
          return [array.length - 1, 1];
        }
        return null;

      case "push":
        return [array.length, 0].concat(args);

      case "shift":
        return [0, 1];

      case "unshift":
        return [0, 0].concat(args);
    }
  }
  //# sourceMappingURL=02-6to5-getNewIndices.js.map

  var arrayProto = Array.prototype;

  var makeArrayMethod = function (methodName) {
    return function (keypath) {
      for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
        args[_key - 1] = arguments[_key];
      }

      var array,
          newIndices = [],
          len,
          promise,
          result;

      keypath = getKeypath(normalise(keypath));

      array = this.viewmodel.get(keypath);
      len = array.length;

      if (!isArray(array)) {
        throw new Error("Called ractive." + methodName + "('" + keypath + "'), but '" + keypath + "' does not refer to an array");
      }

      newIndices = getNewIndices(array, methodName, args);

      result = arrayProto[methodName].apply(array, args);
      promise = runloop.start(this, true).then(function () {
        return result;
      });

      if (!!newIndices) {
        this.viewmodel.smartUpdate(keypath, array, newIndices);
      } else {
        this.viewmodel.mark(keypath);
      }

      runloop.end();

      return promise;
    };
  };
  //# sourceMappingURL=02-6to5-makeArrayMethod.js.map

  var pop = makeArrayMethod("pop");
  //# sourceMappingURL=02-6to5-pop.js.map

  var push = makeArrayMethod("push");
  //# sourceMappingURL=02-6to5-push.js.map

  var css,
      css__update,
      styleElement,
      head,
      styleSheet,
      inDom,
      css__prefix = "/* Ractive.js component styles */\n",
      componentsInPage = {},
      styles = [];

  if (!isClient) {
    css = null;
  } else {
    styleElement = document.createElement("style");
    styleElement.type = "text/css";

    head = document.getElementsByTagName("head")[0];

    inDom = false;

    // Internet Exploder won't let you use styleSheet.innerHTML - we have to
    // use styleSheet.cssText instead
    styleSheet = styleElement.styleSheet;

    css__update = function () {
      var css;

      if (styles.length) {
        css = css__prefix + styles.join(" ");

        if (styleSheet) {
          styleSheet.cssText = css;
        } else {
          styleElement.innerHTML = css;
        }

        if (!inDom) {
          head.appendChild(styleElement);
          inDom = true;
        }
      } else if (inDom) {
        head.removeChild(styleElement);
        inDom = false;
      }
    };

    css = {
      add: function (Component) {
        if (!Component.css) {
          return;
        }

        if (!componentsInPage[Component._guid]) {
          // we create this counter so that we can in/decrement it as
          // instances are added and removed. When all components are
          // removed, the style is too
          componentsInPage[Component._guid] = 0;
          styles.push(Component.css);

          css__update(); // TODO can we only do this once for each runloop turn, but still ensure CSS is updated before onrender() methods are called?
        }

        componentsInPage[Component._guid] += 1;
      },

      remove: function (Component) {
        if (!Component.css) {
          return;
        }

        componentsInPage[Component._guid] -= 1;

        if (!componentsInPage[Component._guid]) {
          removeFromArray(styles, Component.css);
          runloop.scheduleTask(css__update);
        }
      }
    };
  }

  var css__default = css;
  //# sourceMappingURL=02-6to5-css.js.map

  var renderHook = new Hook("render"),
      completeHook = new Hook("complete");

  function Ractive$render(target, anchor) {
    var _this = this;
    var promise, instances, transitionsEnabled;

    // if `noIntro` is `true`, temporarily disable transitions
    transitionsEnabled = this.transitionsEnabled;
    if (this.noIntro) {
      this.transitionsEnabled = false;
    }

    promise = runloop.start(this, true);
    runloop.scheduleTask(function () {
      return renderHook.fire(_this);
    }, true);

    if (this.fragment.rendered) {
      throw new Error("You cannot call ractive.render() on an already rendered instance! Call ractive.unrender() first");
    }

    target = getElement(target) || this.el;
    anchor = getElement(anchor) || this.anchor;

    this.el = target;
    this.anchor = anchor;

    if (!this.append && target) {
      // Teardown any existing instances *before* trying to set up the new one -
      // avoids certain weird bugs
      var others = target.__ractive_instances__;
      if (others && others.length) {
        removeOtherInstances(others);
      }

      // make sure we are the only occupants
      target.innerHTML = ""; // TODO is this quicker than removeChild? Initial research inconclusive
    }

    // Add CSS, if applicable
    if (this.constructor.css) {
      css__default.add(this.constructor);
    }

    if (target) {
      if (!(instances = target.__ractive_instances__)) {
        target.__ractive_instances__ = [this];
      } else {
        instances.push(this);
      }

      if (anchor) {
        target.insertBefore(this.fragment.render(), anchor);
      } else {
        target.appendChild(this.fragment.render());
      }
    }

    runloop.end();

    this.transitionsEnabled = transitionsEnabled;

    // It is now more problematic to know if the complete hook
    // would fire. Method checking is straight-forward, but would
    // also require preflighting event subscriptions. Which seems
    // like more work then just letting the promise happen.
    // But perhaps I'm wrong about that...
    promise.then(function () {
      return completeHook.fire(_this);
    }).then(null, consoleError);

    return promise;
  }

  function removeOtherInstances(others) {
    try {
      others.splice(0, others.length).forEach(function (r) {
        return r.teardown();
      });
    } catch (err) {}
  }
  // this can happen with IE8, because it is unbelievably shit. Somehow, in
  // certain very specific situations, trying to access node.parentNode (which
  // we need to do in order to detach elements) causes an 'Invalid argument'
  // error to be thrown. I don't even.
  //# sourceMappingURL=02-6to5-render.js.map

  var processWrapper = function (wrapper, array, methodName, newIndices) {
    var root = wrapper.root;
    var keypath = wrapper.keypath;


    // If this is a sort or reverse, we just do root.set()...
    // TODO use merge logic?
    if (methodName === "sort" || methodName === "reverse") {
      root.viewmodel.set(keypath, array);
      return;
    }

    root.viewmodel.smartUpdate(keypath, array, newIndices);
  };
  //# sourceMappingURL=02-6to5-processWrapper.js.map

  var patchedArrayProto = [],
      mutatorMethods = ["pop", "push", "reverse", "shift", "sort", "splice", "unshift"],
      testObj,
      patchArrayMethods,
      unpatchArrayMethods;

  mutatorMethods.forEach(function (methodName) {
    var method = function () {
      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      var newIndices, result, wrapper, i;

      newIndices = getNewIndices(this, methodName, args);

      // apply the underlying method
      result = Array.prototype[methodName].apply(this, arguments);

      // trigger changes
      runloop.start();

      this._ractive.setting = true;
      i = this._ractive.wrappers.length;
      while (i--) {
        wrapper = this._ractive.wrappers[i];

        runloop.addViewmodel(wrapper.root.viewmodel);
        processWrapper(wrapper, this, methodName, newIndices);
      }

      runloop.end();

      this._ractive.setting = false;
      return result;
    };

    defineProperty(patchedArrayProto, methodName, {
      value: method
    });
  });

  // can we use prototype chain injection?
  // http://perfectionkills.com/how-ecmascript-5-still-does-not-allow-to-subclass-an-array/#wrappers_prototype_chain_injection
  testObj = {};

  if (testObj.__proto__) {
    // yes, we can
    patchArrayMethods = function (array) {
      array.__proto__ = patchedArrayProto;
    };

    unpatchArrayMethods = function (array) {
      array.__proto__ = Array.prototype;
    };
  } else {
    // no, we can't
    patchArrayMethods = function (array) {
      var i, methodName;

      i = mutatorMethods.length;
      while (i--) {
        methodName = mutatorMethods[i];
        defineProperty(array, methodName, {
          value: patchedArrayProto[methodName],
          configurable: true
        });
      }
    };

    unpatchArrayMethods = function (array) {
      var i;

      i = mutatorMethods.length;
      while (i--) {
        delete array[mutatorMethods[i]];
      }
    };
  }

  patchArrayMethods.unpatch = unpatchArrayMethods;
  var patch = patchArrayMethods;
  //# sourceMappingURL=02-6to5-patch.js.map

  var arrayAdaptor,

  // helpers
  ArrayWrapper, errorMessage;

  arrayAdaptor = {
    filter: function (object) {
      // wrap the array if a) b) it's an array, and b) either it hasn't been wrapped already,
      // or the array didn't trigger the get() itself
      return isArray(object) && (!object._ractive || !object._ractive.setting);
    },
    wrap: function (ractive, array, keypath) {
      return new ArrayWrapper(ractive, array, keypath);
    }
  };

  ArrayWrapper = function (ractive, array, keypath) {
    this.root = ractive;
    this.value = array;
    this.keypath = getKeypath(keypath);

    // if this array hasn't already been ractified, ractify it
    if (!array._ractive) {
      // define a non-enumerable _ractive property to store the wrappers
      defineProperty(array, "_ractive", {
        value: {
          wrappers: [],
          instances: [],
          setting: false
        },
        configurable: true
      });

      patch(array);
    }

    // store the ractive instance, so we can handle transitions later
    if (!array._ractive.instances[ractive._guid]) {
      array._ractive.instances[ractive._guid] = 0;
      array._ractive.instances.push(ractive);
    }

    array._ractive.instances[ractive._guid] += 1;
    array._ractive.wrappers.push(this);
  };

  ArrayWrapper.prototype = {
    get: function () {
      return this.value;
    },
    teardown: function () {
      var array, storage, wrappers, instances, index;

      array = this.value;
      storage = array._ractive;
      wrappers = storage.wrappers;
      instances = storage.instances;

      // if teardown() was invoked because we're clearing the cache as a result of
      // a change that the array itself triggered, we can save ourselves the teardown
      // and immediate setup
      if (storage.setting) {
        return false; // so that we don't remove it from this.root.viewmodel.wrapped
      }

      index = wrappers.indexOf(this);
      if (index === -1) {
        throw new Error(errorMessage);
      }

      wrappers.splice(index, 1);

      // if nothing else depends on this array, we can revert it to its
      // natural state
      if (!wrappers.length) {
        delete array._ractive;
        patch.unpatch(this.value);
      } else {
        // remove ractive instance if possible
        instances[this.root._guid] -= 1;
        if (!instances[this.root._guid]) {
          index = instances.indexOf(this.root);

          if (index === -1) {
            throw new Error(errorMessage);
          }

          instances.splice(index, 1);
        }
      }
    }
  };

  errorMessage = "Something went wrong in a rather interesting way";

  //# sourceMappingURL=02-6to5-index.js.map

  var numeric = /^\s*[0-9]+\s*$/;

  var createBranch = function (key) {
    return numeric.test(key) ? [] : {};
  };
  //# sourceMappingURL=02-6to5-createBranch.js.map

  var magicAdaptor, MagicWrapper;

  try {
    Object.defineProperty({}, "test", { value: 0 });

    magicAdaptor = {
      filter: function (object, keypath, ractive) {
        var parentWrapper, parentValue;

        if (!keypath) {
          return false;
        }

        keypath = getKeypath(keypath);

        // If the parent value is a wrapper, other than a magic wrapper,
        // we shouldn't wrap this property
        if ((parentWrapper = ractive.viewmodel.wrapped[keypath.parent.str]) && !parentWrapper.magic) {
          return false;
        }

        parentValue = ractive.viewmodel.get(keypath.parent);

        // if parentValue is an array that doesn't include this member,
        // we should return false otherwise lengths will get messed up
        if (isArray(parentValue) && /^[0-9]+$/.test(keypath.lastKey)) {
          return false;
        }

        return parentValue && (typeof parentValue === "object" || typeof parentValue === "function");
      },
      wrap: function (ractive, property, keypath) {
        return new MagicWrapper(ractive, property, keypath);
      }
    };

    MagicWrapper = function (ractive, value, keypath) {
      var objKeypath, template, siblings;

      keypath = getKeypath(keypath);

      this.magic = true;

      this.ractive = ractive;
      this.keypath = keypath;
      this.value = value;

      this.prop = keypath.lastKey;

      objKeypath = keypath.parent;
      this.obj = objKeypath.isRoot ? ractive.data : ractive.viewmodel.get(objKeypath);

      template = this.originalDescriptor = Object.getOwnPropertyDescriptor(this.obj, this.prop);

      // Has this property already been wrapped?
      if (template && template.set && (siblings = template.set._ractiveWrappers)) {
        // Yes. Register this wrapper to this property, if it hasn't been already
        if (siblings.indexOf(this) === -1) {
          siblings.push(this);
        }

        return; // already wrapped
      }

      // No, it hasn't been wrapped
      createAccessors(this, value, template);
    };

    MagicWrapper.prototype = {
      get: function () {
        return this.value;
      },
      reset: function (value) {
        if (this.updating) {
          return;
        }

        this.updating = true;
        this.obj[this.prop] = value; // trigger set() accessor
        runloop.addViewmodel(this.ractive.viewmodel);
        this.ractive.viewmodel.mark(this.keypath, { keepExistingWrapper: true });
        this.updating = false;
        return true;
      },
      set: function (key, value) {
        if (this.updating) {
          return;
        }

        if (!this.obj[this.prop]) {
          this.updating = true;
          this.obj[this.prop] = createBranch(key);
          this.updating = false;
        }

        this.obj[this.prop][key] = value;
      },
      teardown: function () {
        var template, set, value, wrappers, index;

        // If this method was called because the cache was being cleared as a
        // result of a set()/update() call made by this wrapper, we return false
        // so that it doesn't get torn down
        if (this.updating) {
          return false;
        }

        template = Object.getOwnPropertyDescriptor(this.obj, this.prop);
        set = template && template.set;

        if (!set) {
          // most likely, this was an array member that was spliced out
          return;
        }

        wrappers = set._ractiveWrappers;

        index = wrappers.indexOf(this);
        if (index !== -1) {
          wrappers.splice(index, 1);
        }

        // Last one out, turn off the lights
        if (!wrappers.length) {
          value = this.obj[this.prop];

          Object.defineProperty(this.obj, this.prop, this.originalDescriptor || {
            writable: true,
            enumerable: true,
            configurable: true
          });

          this.obj[this.prop] = value;
        }
      }
    };
  } catch (err) {
    magicAdaptor = false; // no magic in this browser
  }



  function createAccessors(originalWrapper, value, template) {
    var updateWrapper = function (wrapper) {
      var keypath, ractive;

      wrapper.value = value;

      if (wrapper.updating) {
        return;
      }

      ractive = wrapper.ractive;
      keypath = wrapper.keypath;

      wrapper.updating = true;
      runloop.start(ractive);

      ractive.viewmodel.mark(keypath);

      runloop.end();
      wrapper.updating = false;
    };

    var object, property, oldGet, oldSet, get, set;

    object = originalWrapper.obj;
    property = originalWrapper.prop;

    // Is this template configurable?
    if (template && !template.configurable) {
      // Special case - array length
      if (property === "length") {
        return;
      }

      throw new Error("Cannot use magic mode with property \"" + property + "\" - object is not configurable");
    }


    // Time to wrap this property
    if (template) {
      oldGet = template.get;
      oldSet = template.set;
    }

    get = oldGet || function () {
      return value;
    };

    set = function (v) {
      if (oldSet) {
        oldSet(v);
      }

      value = oldGet ? oldGet() : v;
      set._ractiveWrappers.forEach(updateWrapper);
    };

    // Create an array of wrappers, in case other keypaths/ractives depend on this property.
    // Handily, we can store them as a property of the set function. Yay JavaScript.
    set._ractiveWrappers = [originalWrapper];
    Object.defineProperty(object, property, { get: get, set: set, enumerable: true, configurable: true });
  }
  //# sourceMappingURL=02-6to5-magic.js.map

  var magicArrayAdaptor, MagicArrayWrapper;

  if (magicAdaptor) {
    magicArrayAdaptor = {
      filter: function (object, keypath, ractive) {
        return magicAdaptor.filter(object, keypath, ractive) && arrayAdaptor.filter(object);
      },

      wrap: function (ractive, array, keypath) {
        return new MagicArrayWrapper(ractive, array, keypath);
      }
    };

    MagicArrayWrapper = function (ractive, array, keypath) {
      this.value = array;

      this.magic = true;

      this.magicWrapper = magicAdaptor.wrap(ractive, array, keypath);
      this.arrayWrapper = arrayAdaptor.wrap(ractive, array, keypath);
    };

    MagicArrayWrapper.prototype = {
      get: function () {
        return this.value;
      },
      teardown: function () {
        this.arrayWrapper.teardown();
        this.magicWrapper.teardown();
      },
      reset: function (value) {
        return this.magicWrapper.reset(value);
      }
    };
  }


  //# sourceMappingURL=02-6to5-magicArray.js.map

  var adaptConfigurator = {
    extend: function (Parent, proto, options) {
      proto.adapt = adaptConfigurator__combine(proto.adapt, ensureArray(options.adapt));
    },

    init: function (Parent, ractive, options) {
      var lookup = function (adaptor) {
        if (typeof adaptor === "string") {
          adaptor = findInViewHierarchy("adaptors", ractive, adaptor);

          if (!adaptor) {
            fatal(missingPlugin(adaptor, "adaptor"));
          }
        }

        return adaptor;
      };

      var protoAdapt, adapt;

      protoAdapt = ractive.adapt.map(lookup);
      adapt = ensureArray(options.adapt).map(lookup);

      ractive.adapt = adaptConfigurator__combine(protoAdapt, adapt);

      if (ractive.magic) {
        if (!magic) {
          throw new Error("Getters and setters (magic mode) are not supported in this browser");
        }

        if (ractive.modifyArrays) {
          ractive.adapt.push(magicArrayAdaptor);
        }

        ractive.adapt.push(magicAdaptor);
      }

      if (ractive.modifyArrays) {
        ractive.adapt.push(arrayAdaptor);
      }
    }
  };



  function adaptConfigurator__combine(a, b) {
    var c = a.slice(),
        i = b.length;

    while (i--) {
      if (! ~c.indexOf(b[i])) {
        c.push(b[i]);
      }
    }

    return c;
  }
  //# sourceMappingURL=02-6to5-adapt.js.map

  var selectorsPattern = /(?:^|\})?\s*([^\{\}]+)\s*\{/g,
      commentsPattern = /\/\*.*?\*\//g,
      selectorUnitPattern = /((?:(?:\[[^\]+]\])|(?:[^\s\+\>\~:]))+)((?::[^\s\+\>\~\(]+(?:\([^\)]+\))?)?\s*[\s\+\>\~]?)\s*/g,
      mediaQueryPattern = /^@media/,
      dataRvcGuidPattern = /\[data-ractive-css="[a-z0-9-]+"]/g;

  function transformCss(css, id) {
    var transformed, dataAttr, addGuid;

    dataAttr = "[data-ractive-css=\"" + id + "\"]";

    addGuid = function (selector) {
      var selectorUnits,
          match,
          unit,
          base,
          prepended,
          appended,
          i,
          transformed = [];

      selectorUnits = [];

      while (match = selectorUnitPattern.exec(selector)) {
        selectorUnits.push({
          str: match[0],
          base: match[1],
          modifiers: match[2]
        });
      }

      // For each simple selector within the selector, we need to create a version
      // that a) combines with the id, and b) is inside the id
      base = selectorUnits.map(extractString);

      i = selectorUnits.length;
      while (i--) {
        appended = base.slice();

        // Pseudo-selectors should go after the attribute selector
        unit = selectorUnits[i];
        appended[i] = unit.base + dataAttr + unit.modifiers || "";

        prepended = base.slice();
        prepended[i] = dataAttr + " " + prepended[i];

        transformed.push(appended.join(" "), prepended.join(" "));
      }

      return transformed.join(", ");
    };

    if (dataRvcGuidPattern.test(css)) {
      transformed = css.replace(dataRvcGuidPattern, dataAttr);
    } else {
      transformed = css.replace(commentsPattern, "").replace(selectorsPattern, function (match, $1) {
        var selectors, transformed;

        // don't transform media queries!
        if (mediaQueryPattern.test($1)) return match;

        selectors = $1.split(",").map(trim);
        transformed = selectors.map(addGuid).join(", ") + " ";

        return match.replace($1, transformed);
      });
    }

    return transformed;
  }

  function trim(str) {
    if (str.trim) {
      return str.trim();
    }

    return str.replace(/^\s+/, "").replace(/\s+$/, "");
  }

  function extractString(unit) {
    return unit.str;
  }
  //# sourceMappingURL=02-6to5-transform.js.map

  var cssConfigurator = {
    name: "css",

    extend: function (Parent, proto, options) {
      var guid = proto.constructor._guid,
          css;

      if (css = getCss(options.css, options, guid) || getCss(Parent.css, Parent, guid)) {
        proto.constructor.css = css;
      }
    },

    init: function () {}
  };

  function getCss(css, target, guid) {
    if (!css) {
      return;
    }

    return target.noCssTransform ? css : transformCss(css, guid);
  }


  //# sourceMappingURL=02-6to5-css.js.map

  var wrap__default = function (method, superMethod, force) {
    if (force || needsSuper(method, superMethod)) {
      return function () {
        var hasSuper = ("_super" in this),
            _super = this._super,
            result;

        this._super = superMethod;

        result = method.apply(this, arguments);

        if (hasSuper) {
          this._super = _super;
        }

        return result;
      };
    } else {
      return method;
    }
  };

  function needsSuper(method, superMethod) {
    return typeof superMethod === "function" && /_super/.test(method);
  }
  //# sourceMappingURL=02-6to5-wrapMethod.js.map

  var dataConfigurator = {
    name: "data",

    extend: function (Parent, proto, options) {
      proto.data = dataConfigurator__combine(Parent, proto, options);
    },

    init: function (Parent, ractive, options) {
      var value = options.data,
          result = dataConfigurator__combine(Parent, ractive, options);

      if (typeof result === "function") {
        result = result.call(ractive, value) || value;
      }

      return ractive.data = result || {};
    },

    reset: function (ractive) {
      var result = this.init(ractive.constructor, ractive, ractive);

      if (result) {
        ractive.data = result;
        return true;
      }
    }
  };



  function dataConfigurator__combine(Parent, target, options) {
    var value = options.data || {},
        parentValue = getAddedKeys(Parent.prototype.data);

    if (typeof value !== "object" && typeof value !== "function") {
      throw new TypeError("data option must be an object or a function, \"" + value + "\" is not valid");
    }

    return dispatch(parentValue, value);
  }

  function getAddedKeys(parent) {
    // only for functions that had keys added
    if (typeof parent !== "function" || !Object.keys(parent).length) {
      return parent;
    }

    // copy the added keys to temp 'object', otherwise
    // parent would be interpreted as 'function' by dispatch
    var temp = {};
    copy(parent, temp);

    // roll in added keys
    return dispatch(parent, temp);
  }

  function dispatch(parent, child) {
    if (typeof child === "function") {
      return extendFn(child, parent);
    } else if (typeof parent === "function") {
      return fromFn(child, parent);
    } else {
      return fromProperties(child, parent);
    }
  }

  function copy(from, to, fillOnly) {
    for (var key in from) {
      if (!(to._mappings && to._mappings[key] && to._mappings[key].updatable) && fillOnly && key in to) {
        continue;
      }

      to[key] = from[key];
    }
  }

  function fromProperties(child, parent) {
    child = child || {};

    if (!parent) {
      return child;
    }

    copy(parent, child, true);

    return child;
  }

  function fromFn(child, parentFn) {
    return function (data) {
      var keys;

      if (child) {
        // Track the keys that our on the child,
        // but not on the data. We'll need to apply these
        // after the parent function returns.
        keys = [];

        for (var key in child) {
          if (!data || !(key in data)) {
            keys.push(key);
          }
        }
      }

      // call the parent fn, use data if no return value
      data = parentFn.call(this, data) || data;

      // Copy child keys back onto data. The child keys
      // should take precedence over whatever the
      // parent did with the data.
      if (keys && keys.length) {
        data = data || {};

        keys.forEach(function (key) {
          data[key] = child[key];
        });
      }

      return data;
    };
  }

  function extendFn(childFn, parent) {
    var parentFn;

    if (typeof parent !== "function") {
      // copy props to data
      parentFn = function (data) {
        fromProperties(data, parent);
      };
    } else {
      parentFn = function (data) {
        // give parent function it's own this._super context,
        // otherwise this._super is from child and
        // causes infinite loop
        parent = wrap__default(parent, function () {}, true);

        return parent.call(this, data) || data;
      };
    }

    return wrap__default(childFn, parentFn);
  }
  //# sourceMappingURL=02-6to5-data.js.map

  var TEXT = 1;
  var INTERPOLATOR = 2;
  var TRIPLE = 3;
  var SECTION = 4;
  var INVERTED = 5;
  var CLOSING = 6;
  var ELEMENT = 7;
  var PARTIAL = 8;
  var COMMENT = 9;
  var DELIMCHANGE = 10;
  var MUSTACHE = 11;
  var TAG = 12;
  var ATTRIBUTE = 13;
  var CLOSING_TAG = 14;
  var COMPONENT = 15;
  var YIELDER = 16;
  var INLINE_PARTIAL = 17;
  var DOCTYPE = 18;

  var NUMBER_LITERAL = 20;
  var STRING_LITERAL = 21;
  var ARRAY_LITERAL = 22;
  var OBJECT_LITERAL = 23;
  var BOOLEAN_LITERAL = 24;

  var GLOBAL = 26;
  var KEY_VALUE_PAIR = 27;


  var REFERENCE = 30;
  var REFINEMENT = 31;
  var MEMBER = 32;
  var PREFIX_OPERATOR = 33;
  var BRACKETED = 34;
  var CONDITIONAL = 35;
  var INFIX_OPERATOR = 36;

  var INVOCATION = 40;

  var SECTION_IF = 50;
  var SECTION_UNLESS = 51;
  var SECTION_EACH = 52;
  var SECTION_WITH = 53;
  var SECTION_IF_WITH = 54;
  var SECTION_PARTIAL = 55;

  var ELSE = 60;
  var ELSEIF = 61;
  //# sourceMappingURL=02-6to5-types.js.map

  var Parser,
      ParseError,
      Parser__leadingWhitespace = /^\s+/;

  ParseError = function (message) {
    this.name = "ParseError";
    this.message = message;
    try {
      throw new Error(message);
    } catch (e) {
      this.stack = e.stack;
    }
  };

  ParseError.prototype = Error.prototype;

  Parser = function (str, options) {
    var items,
        item,
        lineStart = 0;

    this.str = str;
    this.options = options || {};
    this.pos = 0;

    this.lines = this.str.split("\n");
    this.lineEnds = this.lines.map(function (line) {
      var lineEnd = lineStart + line.length + 1; // +1 for the newline

      lineStart = lineEnd;
      return lineEnd;
    }, 0);

    // Custom init logic
    if (this.init) this.init(str, options);

    items = [];

    while (this.pos < this.str.length && (item = this.read())) {
      items.push(item);
    }

    this.leftover = this.remaining();
    this.result = this.postProcess ? this.postProcess(items, options) : items;
  };

  Parser.prototype = {
    read: function (converters) {
      var pos, i, len, item;

      if (!converters) converters = this.converters;

      pos = this.pos;

      len = converters.length;
      for (i = 0; i < len; i += 1) {
        this.pos = pos; // reset for each attempt

        if (item = converters[i](this)) {
          return item;
        }
      }

      return null;
    },

    getLinePos: function (char) {
      var lineNum = 0,
          lineStart = 0,
          columnNum;

      while (char >= this.lineEnds[lineNum]) {
        lineStart = this.lineEnds[lineNum];
        lineNum += 1;
      }

      columnNum = char - lineStart;
      return [lineNum + 1, columnNum + 1, char]; // line/col should be one-based, not zero-based!
    },

    error: function (message) {
      var pos, lineNum, columnNum, line, annotation, error;

      pos = this.getLinePos(this.pos);
      lineNum = pos[0];
      columnNum = pos[1];

      line = this.lines[pos[0] - 1];
      annotation = line + "\n" + new Array(pos[1]).join(" ") + "^----";

      error = new ParseError(message + " at line " + lineNum + " character " + columnNum + ":\n" + annotation);

      error.line = pos[0];
      error.character = pos[1];
      error.shortMessage = message;

      throw error;
    },

    matchString: function (string) {
      if (this.str.substr(this.pos, string.length) === string) {
        this.pos += string.length;
        return string;
      }
    },

    matchPattern: function (pattern) {
      var match;

      if (match = pattern.exec(this.remaining())) {
        this.pos += match[0].length;
        return match[1] || match[0];
      }
    },

    allowWhitespace: function () {
      this.matchPattern(Parser__leadingWhitespace);
    },

    remaining: function () {
      return this.str.substring(this.pos);
    },

    nextChar: function () {
      return this.str.charAt(this.pos);
    }
  };

  Parser.extend = function (proto) {
    var Parent = this,
        Child,
        key;

    Child = function (str, options) {
      Parser.call(this, str, options);
    };

    Child.prototype = create(Parent.prototype);

    for (key in proto) {
      if (hasOwn.call(proto, key)) {
        Child.prototype[key] = proto[key];
      }
    }

    Child.extend = Parser.extend;
    return Child;
  };


  //# sourceMappingURL=02-6to5-Parser.js.map

  var delimiterChangePattern = /^[^\s=]+/,
      whitespacePattern = /^\s+/;

  function readDelimiterChange(parser) {
    var start, opening, closing;

    if (!parser.matchString("=")) {
      return null;
    }

    start = parser.pos;

    // allow whitespace before new opening delimiter
    parser.allowWhitespace();

    opening = parser.matchPattern(delimiterChangePattern);
    if (!opening) {
      parser.pos = start;
      return null;
    }

    // allow whitespace (in fact, it's necessary...)
    if (!parser.matchPattern(whitespacePattern)) {
      return null;
    }

    closing = parser.matchPattern(delimiterChangePattern);
    if (!closing) {
      parser.pos = start;
      return null;
    }

    // allow whitespace before closing '='
    parser.allowWhitespace();

    if (!parser.matchString("=")) {
      parser.pos = start;
      return null;
    }

    return [opening, closing];
  }
  //# sourceMappingURL=02-6to5-readDelimiterChange.js.map

  var delimiterChangeToken = { t: DELIMCHANGE, exclude: true };

  function readMustache(parser) {
    var mustache, i;

    // If we're inside a <script> or <style> tag, and we're not
    // interpolating, bug out
    if (parser.interpolate[parser.inside] === false) {
      return null;
    }

    for (i = 0; i < parser.tags.length; i += 1) {
      if (mustache = readMustacheOfType(parser, parser.tags[i])) {
        return mustache;
      }
    }
  }

  function readMustacheOfType(parser, tag) {
    var start, mustache, reader, i;

    start = parser.pos;

    if (!parser.matchString(tag.open)) {
      return null;
    }

    // delimiter change?
    if (mustache = readDelimiterChange(parser)) {
      // find closing delimiter or abort...
      if (!parser.matchString(tag.close)) {
        return null;
      }

      // ...then make the switch
      tag.open = mustache[0];
      tag.close = mustache[1];
      parser.sortMustacheTags();

      return delimiterChangeToken;
    }

    parser.allowWhitespace();

    // illegal section closer
    if (parser.matchString("/")) {
      parser.pos -= tag.close.length + 1;
      parser.error("Attempted to close a section that wasn't open");
    }

    for (i = 0; i < tag.readers.length; i += 1) {
      reader = tag.readers[i];

      if (mustache = reader(parser, tag)) {
        if (tag.isStatic) {
          mustache.s = true; // TODO make this `1` instead - more compact
        }

        if (parser.includeLinePositions) {
          mustache.p = parser.getLinePos(start);
        }

        return mustache;
      }
    }

    parser.pos = start;
    return null;
  }
  //# sourceMappingURL=02-6to5-readMustache.js.map

  var expectedExpression = "Expected a JavaScript expression";
  var expectedParen = "Expected closing paren";
  //# sourceMappingURL=02-6to5-errors.js.map

  var readNumberLiteral__numberPattern = /^(?:[+-]?)(?:(?:(?:0|[1-9]\d*)?\.\d+)|(?:(?:0|[1-9]\d*)\.)|(?:0|[1-9]\d*))(?:[eE][+-]?\d+)?/;

  function readNumberLiteral(parser) {
    var result;

    if (result = parser.matchPattern(readNumberLiteral__numberPattern)) {
      return {
        t: NUMBER_LITERAL,
        v: result
      };
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-readNumberLiteral.js.map

  function readBooleanLiteral(parser) {
    var remaining = parser.remaining();

    if (remaining.substr(0, 4) === "true") {
      parser.pos += 4;
      return {
        t: BOOLEAN_LITERAL,
        v: "true"
      };
    }

    if (remaining.substr(0, 5) === "false") {
      parser.pos += 5;
      return {
        t: BOOLEAN_LITERAL,
        v: "false"
      };
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-readBooleanLiteral.js.map

  var stringMiddlePattern, escapeSequencePattern, lineContinuationPattern;

  // Match one or more characters until: ", ', \, or EOL/EOF.
  // EOL/EOF is written as (?!.) (meaning there's no non-newline char next).
  stringMiddlePattern = /^(?=.)[^"'\\]+?(?:(?!.)|(?=["'\\]))/;

  // Match one escape sequence, including the backslash.
  escapeSequencePattern = /^\\(?:['"\\bfnrt]|0(?![0-9])|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|(?=.)[^ux0-9])/;

  // Match one ES5 line continuation (backslash + line terminator).
  lineContinuationPattern = /^\\(?:\r\n|[\u000A\u000D\u2028\u2029])/;

  // Helper for defining getDoubleQuotedString and getSingleQuotedString.
  var makeQuotedStringMatcher = function (okQuote) {
    return function (parser) {
      var start, literal, done, next;

      start = parser.pos;
      literal = "\"";
      done = false;

      while (!done) {
        next = parser.matchPattern(stringMiddlePattern) || parser.matchPattern(escapeSequencePattern) || parser.matchString(okQuote);
        if (next) {
          if (next === "\"") {
            literal += "\\\"";
          } else if (next === "\\'") {
            literal += "'";
          } else {
            literal += next;
          }
        } else {
          next = parser.matchPattern(lineContinuationPattern);
          if (next) {
            // convert \(newline-like) into a \u escape, which is allowed in JSON
            literal += "\\u" + ("000" + next.charCodeAt(1).toString(16)).slice(-4);
          } else {
            done = true;
          }
        }
      }

      literal += "\"";

      // use JSON.parse to interpret escapes
      return JSON.parse(literal);
    };
  };
  //# sourceMappingURL=02-6to5-makeQuotedStringMatcher.js.map

  var getSingleQuotedString = makeQuotedStringMatcher("\"");
  var getDoubleQuotedString = makeQuotedStringMatcher("'");

  var readStringLiteral = function (parser) {
    var start, string;

    start = parser.pos;

    if (parser.matchString("\"")) {
      string = getDoubleQuotedString(parser);

      if (!parser.matchString("\"")) {
        parser.pos = start;
        return null;
      }

      return {
        t: STRING_LITERAL,
        v: string
      };
    }

    if (parser.matchString("'")) {
      string = getSingleQuotedString(parser);

      if (!parser.matchString("'")) {
        parser.pos = start;
        return null;
      }

      return {
        t: STRING_LITERAL,
        v: string
      };
    }

    return null;
  };
  //# sourceMappingURL=02-6to5-readStringLiteral.js.map

  var patterns__name = /^[a-zA-Z_$][a-zA-Z_$0-9]*/;
  var patterns__relaxedName = /^[a-zA-Z_$][-a-zA-Z_$0-9]*/;
  //# sourceMappingURL=02-6to5-patterns.js.map

  var identifier = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/;

  // http://mathiasbynens.be/notes/javascript-properties
  // can be any name, string literal, or number literal
  function readKey(parser) {
    var token;

    if (token = readStringLiteral(parser)) {
      return identifier.test(token.v) ? token.v : "\"" + token.v.replace(/"/g, "\\\"") + "\"";
    }

    if (token = readNumberLiteral(parser)) {
      return token.v;
    }

    if (token = parser.matchPattern(patterns__name)) {
      return token;
    }
  }
  //# sourceMappingURL=02-6to5-readKey.js.map

  function readKeyValuePair(parser) {
    var start, key, value;

    start = parser.pos;

    // allow whitespace between '{' and key
    parser.allowWhitespace();

    key = readKey(parser);
    if (key === null) {
      parser.pos = start;
      return null;
    }

    // allow whitespace between key and ':'
    parser.allowWhitespace();

    // next character must be ':'
    if (!parser.matchString(":")) {
      parser.pos = start;
      return null;
    }

    // allow whitespace between ':' and value
    parser.allowWhitespace();

    // next expression must be a, well... expression
    value = readExpression(parser);
    if (value === null) {
      parser.pos = start;
      return null;
    }

    return {
      t: KEY_VALUE_PAIR,
      k: key,
      v: value
    };
  }
  //# sourceMappingURL=02-6to5-keyValuePair.js.map

  function readKeyValuePairs(parser) {
    var start, pairs, pair, keyValuePairs;

    start = parser.pos;

    pair = readKeyValuePair(parser);
    if (pair === null) {
      return null;
    }

    pairs = [pair];

    if (parser.matchString(",")) {
      keyValuePairs = readKeyValuePairs(parser);

      if (!keyValuePairs) {
        parser.pos = start;
        return null;
      }

      return pairs.concat(keyValuePairs);
    }

    return pairs;
  }
  //# sourceMappingURL=02-6to5-keyValuePairs.js.map

  var readObjectLiteral = function (parser) {
    var start, keyValuePairs;

    start = parser.pos;

    // allow whitespace
    parser.allowWhitespace();

    if (!parser.matchString("{")) {
      parser.pos = start;
      return null;
    }

    keyValuePairs = readKeyValuePairs(parser);

    // allow whitespace between final value and '}'
    parser.allowWhitespace();

    if (!parser.matchString("}")) {
      parser.pos = start;
      return null;
    }

    return {
      t: OBJECT_LITERAL,
      m: keyValuePairs
    };
  };
  //# sourceMappingURL=02-6to5-readObjectLiteral.js.map

  function readExpressionList(parser) {
    var append = function (expression) {
      expressions.push(expression);
    };

    var start, expressions, expr, next;

    start = parser.pos;

    parser.allowWhitespace();

    expr = readExpression(parser);

    if (expr === null) {
      return null;
    }

    expressions = [expr];

    // allow whitespace between expression and ','
    parser.allowWhitespace();

    if (parser.matchString(",")) {
      next = readExpressionList(parser);
      if (next === null) {
        parser.error(expectedExpression);
      }

      next.forEach(append);
    }

    return expressions;
  }
  //# sourceMappingURL=02-6to5-readExpressionList.js.map

  var readArrayLiteral = function (parser) {
    var start, expressionList;

    start = parser.pos;

    // allow whitespace before '['
    parser.allowWhitespace();

    if (!parser.matchString("[")) {
      parser.pos = start;
      return null;
    }

    expressionList = readExpressionList(parser);

    if (!parser.matchString("]")) {
      parser.pos = start;
      return null;
    }

    return {
      t: ARRAY_LITERAL,
      m: expressionList
    };
  };
  //# sourceMappingURL=02-6to5-readArrayLiteral.js.map

  function readLiteral(parser) {
    return readNumberLiteral(parser) || readBooleanLiteral(parser) || readStringLiteral(parser) || readObjectLiteral(parser) || readArrayLiteral(parser);
  }
  //# sourceMappingURL=02-6to5-readLiteral.js.map

  var prefixPattern = /^(?:~\/|(?:\.\.\/)+|\.\/(?:\.\.\/)*|\.)/,
      globals,
      keywords;

  // if a reference is a browser global, we don't deference it later, so it needs special treatment
  globals = /^(?:Array|console|Date|RegExp|decodeURIComponent|decodeURI|encodeURIComponent|encodeURI|isFinite|isNaN|parseFloat|parseInt|JSON|Math|NaN|undefined|null)\b/;

  // keywords are not valid references, with the exception of `this`
  keywords = /^(?:break|case|catch|continue|debugger|default|delete|do|else|finally|for|function|if|in|instanceof|new|return|switch|throw|try|typeof|var|void|while|with)$/;

  var legalReference = /^[a-zA-Z$_0-9]+(?:(?:\.[a-zA-Z$_0-9]+)|(?:\[[0-9]+\]))*/;
  var readReference__relaxedName = /^[a-zA-Z_$][-a-zA-Z_$0-9]*/;

  function readReference(parser) {
    var startPos, prefix, name, global, reference, lastDotIndex;

    startPos = parser.pos;

    name = parser.matchPattern(/^@(?:keypath|index|key)/);

    if (!name) {
      prefix = parser.matchPattern(prefixPattern) || "";
      name = !prefix && parser.relaxedNames && parser.matchPattern(readReference__relaxedName) || parser.matchPattern(legalReference);

      if (!name && prefix === ".") {
        prefix = "";
        name = ".";
      }
    }

    if (!name) {
      return null;
    }

    // bug out if it's a keyword (exception for ancestor/restricted refs - see https://github.com/ractivejs/ractive/issues/1497)
    if (!prefix && !parser.relaxedNames && keywords.test(name)) {
      parser.pos = startPos;
      return null;
    }

    // if this is a browser global, stop here
    if (!prefix && globals.test(name)) {
      global = globals.exec(name)[0];
      parser.pos = startPos + global.length;

      return {
        t: GLOBAL,
        v: global
      };
    }

    reference = (prefix || "") + normalise(name);

    if (parser.matchString("(")) {
      // if this is a method invocation (as opposed to a function) we need
      // to strip the method name from the reference combo, else the context
      // will be wrong
      lastDotIndex = name.lastIndexOf(".");
      if (lastDotIndex !== -1) {
        reference = reference.substr(0, lastDotIndex);
        parser.pos = startPos + reference.length;
      } else {
        parser.pos -= 1;
      }
    }

    return {
      t: REFERENCE,
      n: reference.replace(/^this\./, "./").replace(/^this$/, ".")
    };
  }
  //# sourceMappingURL=02-6to5-readReference.js.map

  function readBracketedExpression(parser) {
    var start, expr;

    start = parser.pos;

    if (!parser.matchString("(")) {
      return null;
    }

    parser.allowWhitespace();

    expr = readExpression(parser);
    if (!expr) {
      parser.error(expectedExpression);
    }

    parser.allowWhitespace();

    if (!parser.matchString(")")) {
      parser.error(expectedParen);
    }

    return {
      t: BRACKETED,
      x: expr
    };
  }
  //# sourceMappingURL=02-6to5-readBracketedExpression.js.map

  var readPrimary = function (parser) {
    return readLiteral(parser) || readReference(parser) || readBracketedExpression(parser);
  };
  //# sourceMappingURL=02-6to5-readPrimary.js.map

  function readRefinement(parser) {
    var start, name, expr;

    start = parser.pos;

    parser.allowWhitespace();

    // "." name
    if (parser.matchString(".")) {
      parser.allowWhitespace();

      if (name = parser.matchPattern(patterns__name)) {
        return {
          t: REFINEMENT,
          n: name
        };
      }

      parser.error("Expected a property name");
    }

    // "[" expression "]"
    if (parser.matchString("[")) {
      parser.allowWhitespace();

      expr = readExpression(parser);
      if (!expr) {
        parser.error(expectedExpression);
      }

      parser.allowWhitespace();

      if (!parser.matchString("]")) {
        parser.error("Expected ']'");
      }

      return {
        t: REFINEMENT,
        x: expr
      };
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-readRefinement.js.map

  var readMemberOrInvocation = function (parser) {
    var current, expression, refinement, expressionList;

    expression = readPrimary(parser);

    if (!expression) {
      return null;
    }

    while (expression) {
      current = parser.pos;

      if (refinement = readRefinement(parser)) {
        expression = {
          t: MEMBER,
          x: expression,
          r: refinement
        };
      } else if (parser.matchString("(")) {
        parser.allowWhitespace();
        expressionList = readExpressionList(parser);

        parser.allowWhitespace();

        if (!parser.matchString(")")) {
          parser.error(expectedParen);
        }

        expression = {
          t: INVOCATION,
          x: expression
        };

        if (expressionList) {
          expression.o = expressionList;
        }
      } else {
        break;
      }
    }

    return expression;
  };
  //# sourceMappingURL=02-6to5-readMemberOrInvocation.js.map

  var readTypeOf, makePrefixSequenceMatcher;

  makePrefixSequenceMatcher = function (symbol, fallthrough) {
    return function (parser) {
      var expression;

      if (expression = fallthrough(parser)) {
        return expression;
      }

      if (!parser.matchString(symbol)) {
        return null;
      }

      parser.allowWhitespace();

      expression = readExpression(parser);
      if (!expression) {
        parser.error(expectedExpression);
      }

      return {
        s: symbol,
        o: expression,
        t: PREFIX_OPERATOR
      };
    };
  };

  // create all prefix sequence matchers, return readTypeOf
  (function () {
    var i, len, matcher, prefixOperators, fallthrough;

    prefixOperators = "! ~ + - typeof".split(" ");

    fallthrough = readMemberOrInvocation;
    for (i = 0, len = prefixOperators.length; i < len; i += 1) {
      matcher = makePrefixSequenceMatcher(prefixOperators[i], fallthrough);
      fallthrough = matcher;
    }

    // typeof operator is higher precedence than multiplication, so provides the
    // fallthrough for the multiplication sequence matcher we're about to create
    // (we're skipping void and delete)
    readTypeOf = fallthrough;
  })();

  var readTypeof = readTypeOf;
  //# sourceMappingURL=02-6to5-readTypeof.js.map

  var readLogicalOr, makeInfixSequenceMatcher;

  makeInfixSequenceMatcher = function (symbol, fallthrough) {
    return function (parser) {
      var start, left, right;

      left = fallthrough(parser);
      if (!left) {
        return null;
      }

      // Loop to handle left-recursion in a case like `a * b * c` and produce
      // left association, i.e. `(a * b) * c`.  The matcher can't call itself
      // to parse `left` because that would be infinite regress.
      while (true) {
        start = parser.pos;

        parser.allowWhitespace();

        if (!parser.matchString(symbol)) {
          parser.pos = start;
          return left;
        }

        // special case - in operator must not be followed by [a-zA-Z_$0-9]
        if (symbol === "in" && /[a-zA-Z_$0-9]/.test(parser.remaining().charAt(0))) {
          parser.pos = start;
          return left;
        }

        parser.allowWhitespace();

        // right operand must also consist of only higher-precedence operators
        right = fallthrough(parser);
        if (!right) {
          parser.pos = start;
          return left;
        }

        left = {
          t: INFIX_OPERATOR,
          s: symbol,
          o: [left, right]
        };

        // Loop back around.  If we don't see another occurrence of the symbol,
        // we'll return left.
      }
    };
  };

  // create all infix sequence matchers, and return readLogicalOr
  (function () {
    var i, len, matcher, infixOperators, fallthrough;

    // All the infix operators on order of precedence (source: https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Operators/Operator_Precedence)
    // Each sequence matcher will initially fall through to its higher precedence
    // neighbour, and only attempt to match if one of the higher precedence operators
    // (or, ultimately, a literal, reference, or bracketed expression) already matched
    infixOperators = "* / % + - << >> >>> < <= > >= in instanceof == != === !== & ^ | && ||".split(" ");

    // A typeof operator is higher precedence than multiplication
    fallthrough = readTypeof;
    for (i = 0, len = infixOperators.length; i < len; i += 1) {
      matcher = makeInfixSequenceMatcher(infixOperators[i], fallthrough);
      fallthrough = matcher;
    }

    // Logical OR is the fallthrough for the conditional matcher
    readLogicalOr = fallthrough;
  })();


  //# sourceMappingURL=02-6to5-readLogicalOr.js.map

  function getConditional(parser) {
    var start, expression, ifTrue, ifFalse;

    expression = readLogicalOr(parser);
    if (!expression) {
      return null;
    }

    start = parser.pos;

    parser.allowWhitespace();

    if (!parser.matchString("?")) {
      parser.pos = start;
      return expression;
    }

    parser.allowWhitespace();

    ifTrue = readExpression(parser);
    if (!ifTrue) {
      parser.error(expectedExpression);
    }

    parser.allowWhitespace();

    if (!parser.matchString(":")) {
      parser.error("Expected \":\"");
    }

    parser.allowWhitespace();

    ifFalse = readExpression(parser);
    if (!ifFalse) {
      parser.error(expectedExpression);
    }

    return {
      t: CONDITIONAL,
      o: [expression, ifTrue, ifFalse]
    };
  }
  //# sourceMappingURL=02-6to5-readConditional.js.map

  function readExpression(parser) {
    // The conditional operator is the lowest precedence operator (except yield,
    // assignment operators, and commas, none of which are supported), so we
    // start there. If it doesn't match, it 'falls through' to progressively
    // higher precedence operators, until it eventually matches (or fails to
    // match) a 'primary' - a literal or a reference. This way, the abstract syntax
    // tree has everything in its proper place, i.e. 2 + 3 * 4 === 14, not 20.
    return getConditional(parser);
  }
  //# sourceMappingURL=02-6to5-readExpression.js.map

  function flattenExpression(expression) {
    var stringify = function (node) {
      switch (node.t) {
        case BOOLEAN_LITERAL:
        case GLOBAL:
        case NUMBER_LITERAL:
          return node.v;

        case STRING_LITERAL:
          return JSON.stringify(String(node.v));

        case ARRAY_LITERAL:
          return "[" + (node.m ? node.m.map(stringify).join(",") : "") + "]";

        case OBJECT_LITERAL:
          return "{" + (node.m ? node.m.map(stringify).join(",") : "") + "}";

        case KEY_VALUE_PAIR:
          return node.k + ":" + stringify(node.v);

        case PREFIX_OPERATOR:
          return (node.s === "typeof" ? "typeof " : node.s) + stringify(node.o);

        case INFIX_OPERATOR:
          return stringify(node.o[0]) + (node.s.substr(0, 2) === "in" ? " " + node.s + " " : node.s) + stringify(node.o[1]);

        case INVOCATION:
          return stringify(node.x) + "(" + (node.o ? node.o.map(stringify).join(",") : "") + ")";

        case BRACKETED:
          return "(" + stringify(node.x) + ")";

        case MEMBER:
          return stringify(node.x) + stringify(node.r);

        case REFINEMENT:
          return node.n ? "." + node.n : "[" + stringify(node.x) + "]";

        case CONDITIONAL:
          return stringify(node.o[0]) + "?" + stringify(node.o[1]) + ":" + stringify(node.o[2]);

        case REFERENCE:
          return "_" + refs.indexOf(node.n);

        default:
          throw new Error("Expected legal JavaScript");
      }
    };

    var refs;

    extractRefs(expression, refs = []);

    return {
      r: refs,
      s: stringify(expression)
    };
  }

  // TODO maybe refactor this?
  function extractRefs(node, refs) {
    var i, list;

    if (node.t === REFERENCE) {
      if (refs.indexOf(node.n) === -1) {
        refs.unshift(node.n);
      }
    }

    list = node.o || node.m;
    if (list) {
      if (isObject(list)) {
        extractRefs(list, refs);
      } else {
        i = list.length;
        while (i--) {
          extractRefs(list[i], refs);
        }
      }
    }

    if (node.x) {
      extractRefs(node.x, refs);
    }

    if (node.r) {
      extractRefs(node.r, refs);
    }

    if (node.v) {
      extractRefs(node.v, refs);
    }
  }
  //# sourceMappingURL=02-6to5-flattenExpression.js.map

  var arrayMemberPattern = /^[0-9][1-9]*$/;

  function refineExpression(expression, mustache) {
    var referenceExpression;

    if (expression) {
      while (expression.t === BRACKETED && expression.x) {
        expression = expression.x;
      }

      // special case - integers should be treated as array members references,
      // rather than as expressions in their own right
      if (expression.t === REFERENCE) {
        mustache.r = expression.n;
      } else {
        if (expression.t === NUMBER_LITERAL && arrayMemberPattern.test(expression.v)) {
          mustache.r = expression.v;
        } else if (referenceExpression = getReferenceExpression(expression)) {
          mustache.rx = referenceExpression;
        } else {
          mustache.x = flattenExpression(expression);
        }
      }

      return mustache;
    }
  }

  // TODO refactor this! it's bewildering
  function getReferenceExpression(expression) {
    var members = [],
        refinement;

    while (expression.t === MEMBER && expression.r.t === REFINEMENT) {
      refinement = expression.r;

      if (refinement.x) {
        if (refinement.x.t === REFERENCE) {
          members.unshift(refinement.x);
        } else {
          members.unshift(flattenExpression(refinement.x));
        }
      } else {
        members.unshift(refinement.n);
      }

      expression = expression.x;
    }

    if (expression.t !== REFERENCE) {
      return null;
    }

    return {
      r: expression.n,
      m: members
    };
  }
  //# sourceMappingURL=02-6to5-refineExpression.js.map

  function readTriple(parser, tag) {
    var expression = readExpression(parser),
        triple;

    if (!expression) {
      return null;
    }

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "'");
    }

    triple = { t: TRIPLE };
    refineExpression(expression, triple); // TODO handle this differently - it's mysterious

    return triple;
  }
  //# sourceMappingURL=02-6to5-readTriple.js.map

  function readUnescaped(parser, tag) {
    var expression, triple;

    if (!parser.matchString("&")) {
      return null;
    }

    parser.allowWhitespace();

    expression = readExpression(parser);

    if (!expression) {
      return null;
    }

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "'");
    }

    triple = { t: TRIPLE };
    refineExpression(expression, triple); // TODO handle this differently - it's mysterious

    return triple;
  }
  //# sourceMappingURL=02-6to5-readUnescaped.js.map

  function readPartial(parser, tag) {
    var start, nameStart, expression, context, partial;

    start = parser.pos;

    if (!parser.matchString(">")) {
      return null;
    }

    parser.allowWhitespace();
    nameStart = parser.pos;

    // Partial names can include hyphens, so we can't use readExpression
    // blindly. Instead, we use the `relaxedNames` flag to indicate that
    // `foo-bar` should be read as a single name, rather than 'subtract
    // bar from foo'
    parser.relaxedNames = true;
    expression = readExpression(parser);
    parser.relaxedNames = false;

    parser.allowWhitespace();
    context = readExpression(parser);
    parser.allowWhitespace();

    if (!expression) {
      return null;
    }

    partial = { t: PARTIAL };
    refineExpression(expression, partial); // TODO...

    parser.allowWhitespace();

    // if we have another expression - e.g. `{{>foo bar}}` - then
    // we turn it into `{{#with bar}}{{>foo}}{{/with}}`
    if (context) {
      partial = {
        t: SECTION,
        n: SECTION_WITH,
        f: [partial]
      };

      refineExpression(context, partial);
    }

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "'");
    }

    return partial;
  }
  //# sourceMappingURL=02-6to5-readPartial.js.map

  function readComment(parser, tag) {
    var index;

    if (!parser.matchString("!")) {
      return null;
    }

    index = parser.remaining().indexOf(tag.close);

    if (index !== -1) {
      parser.pos += index + tag.close.length;
      return { t: COMMENT };
    }
  }
  //# sourceMappingURL=02-6to5-readMustacheComment.js.map

  function readExpressionOrReference(parser, expectedFollowers) {
    var start, expression, i;

    start = parser.pos;
    expression = readExpression(parser);

    if (!expression) {
      return null;
    }

    for (i = 0; i < expectedFollowers.length; i += 1) {
      if (parser.remaining().substr(0, expectedFollowers[i].length) === expectedFollowers[i]) {
        return expression;
      }
    }

    parser.pos = start;
    return readReference(parser);
  }
  //# sourceMappingURL=02-6to5-readExpressionOrReference.js.map

  function readInterpolator(parser, tag) {
    var start, expression, interpolator, err;

    start = parser.pos;

    // TODO would be good for perf if we could do away with the try-catch
    try {
      expression = readExpressionOrReference(parser, [tag.close]);
    } catch (e) {
      err = e;
    }

    if (!expression) {
      if (parser.str.charAt(start) === "!") {
        // special case - comment
        return null;
      }

      if (err) {
        throw err;
      }
    }

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "' after reference");

      if (!expression) {
        // special case - comment
        if (parser.nextChar() === "!") {
          return null;
        }

        parser.error("Expected expression or legal reference");
      }
    }

    interpolator = { t: INTERPOLATOR };
    refineExpression(expression, interpolator); // TODO handle this differently - it's mysterious

    return interpolator;
  }
  //# sourceMappingURL=02-6to5-readInterpolator.js.map

  var yieldPattern = /^yield\s*/;

  function readYielder(parser, tag) {
    var start, name, yielder;

    if (!parser.matchPattern(yieldPattern)) {
      return null;
    }

    start = parser.pos;
    name = parser.matchPattern(/^[a-zA-Z_$][a-zA-Z_$0-9\-]*/);

    parser.allowWhitespace();

    if (!parser.matchString(tag.close)) {
      parser.error("expected legal partial name");
    }

    yielder = { t: YIELDER };

    if (name) {
      yielder.n = name;
    }

    return yielder;
  }
  //# sourceMappingURL=02-6to5-readYielder.js.map

  function readClosing(parser, tag) {
    var start, remaining, index, closing;

    start = parser.pos;

    if (!parser.matchString(tag.open)) {
      return null;
    }

    parser.allowWhitespace();

    if (!parser.matchString("/")) {
      parser.pos = start;
      return null;
    }

    parser.allowWhitespace();

    remaining = parser.remaining();
    index = remaining.indexOf(tag.close);

    if (index !== -1) {
      closing = {
        t: CLOSING,
        r: remaining.substr(0, index).split(" ")[0]
      };

      parser.pos += index;

      if (!parser.matchString(tag.close)) {
        parser.error("Expected closing delimiter '" + tag.close + "'");
      }

      return closing;
    }

    parser.pos = start;
    return null;
  }
  //# sourceMappingURL=02-6to5-readClosing.js.map

  var partialDefinitionSectionPattern = /^#\s*partial\s+/;

  function readPartialDefinitionSection(parser, tag) {
    var start, name, content, child, closed;

    if (!parser.matchPattern(partialDefinitionSectionPattern)) {
      return null;
    }

    start = parser.pos;

    name = parser.matchPattern(/^[a-zA-Z_$][a-zA-Z_$0-9\-]*/);

    if (!name) {
      parser.error("expected legal partial name");
    }

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "'");
    }

    content = [];

    do {
      if (child = readClosing(parser, tag)) {
        if (!child.r === "partial") {
          parser.error("Expected " + tag.open + "/partial" + tag.close);
        }

        closed = true;
      } else {
        child = parser.read();

        if (!child) {
          parser.error("Expected " + tag.open + "/partial" + tag.close);
        }

        content.push(child);
      }
    } while (!closed);

    return {
      t: INLINE_PARTIAL,
      n: name,
      f: content
    };
  }
  //# sourceMappingURL=02-6to5-readPartialDefinitionSection.js.map

  var readElse__elsePattern = /^\s*else\s*/;

  function readElse__readElse(parser, tag) {
    var start = parser.pos;

    if (!parser.matchString(tag.open)) {
      return null;
    }

    if (!parser.matchPattern(readElse__elsePattern)) {
      parser.pos = start;
      return null;
    }

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "'");
    }

    return {
      t: ELSE
    };
  }
  //# sourceMappingURL=02-6to5-readElse.js.map

  var readElseIf__elsePattern = /^\s*elseif\s+/;

  function readElseIf__readElse(parser, tag) {
    var start = parser.pos,
        expression;

    if (!parser.matchString(tag.open)) {
      return null;
    }

    if (!parser.matchPattern(readElseIf__elsePattern)) {
      parser.pos = start;
      return null;
    }

    expression = readExpression(parser);

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "'");
    }

    return {
      t: ELSEIF,
      x: expression
    };
  }
  //# sourceMappingURL=02-6to5-readElseIf.js.map

  var handlebarsBlockCodes = {
    each: SECTION_EACH,
    "if": SECTION_IF,
    "if-with": SECTION_IF_WITH,
    "with": SECTION_WITH,
    unless: SECTION_UNLESS,
    partial: SECTION_PARTIAL
  };
  //# sourceMappingURL=02-6to5-handlebarsBlockCodes.js.map

  var indexRefPattern = /^\s*:\s*([a-zA-Z_$][a-zA-Z_$0-9]*)/,
      keyIndexRefPattern = /^\s*,\s*([a-zA-Z_$][a-zA-Z_$0-9]*)/,
      handlebarsBlockPattern = new RegExp("^(" + Object.keys(handlebarsBlockCodes).join("|") + ")\\b");

  function readSection(parser, tag) {
    var start, expression, section, child, children, hasElse, block, unlessBlock, conditions, closed, i, expectedClose;

    start = parser.pos;

    if (parser.matchString("^")) {
      section = { t: SECTION, f: [], n: SECTION_UNLESS };
    } else if (parser.matchString("#")) {
      section = { t: SECTION, f: [] };

      if (block = parser.matchPattern(handlebarsBlockPattern)) {
        expectedClose = block;
        section.n = handlebarsBlockCodes[block];
      }
    } else {
      return null;
    }

    parser.allowWhitespace();

    expression = readExpression(parser);

    if (!expression) {
      parser.error("Expected expression");
    }

    // optional index and key references
    if (i = parser.matchPattern(indexRefPattern)) {
      var extra = undefined;

      if (extra = parser.matchPattern(keyIndexRefPattern)) {
        section.i = i + "," + extra;
      } else {
        section.i = i;
      }
    }

    parser.allowWhitespace();

    if (!parser.matchString(tag.close)) {
      parser.error("Expected closing delimiter '" + tag.close + "'");
    }

    parser.sectionDepth += 1;
    children = section.f;

    conditions = [];

    do {
      if (child = readClosing(parser, tag)) {
        if (expectedClose && child.r !== expectedClose) {
          parser.error("Expected " + tag.open + "/" + expectedClose + "" + tag.close);
        }

        parser.sectionDepth -= 1;
        closed = true;
      } else if (child = readElseIf__readElse(parser, tag)) {
        if (section.n === SECTION_UNLESS) {
          parser.error("{{else}} not allowed in {{#unless}}");
        }

        if (hasElse) {
          parser.error("illegal {{elseif...}} after {{else}}");
        }

        if (!unlessBlock) {
          unlessBlock = createUnlessBlock(expression, section.n);
        }

        unlessBlock.f.push({
          t: SECTION,
          n: SECTION_IF,
          x: flattenExpression(readSection__combine(conditions.concat(child.x))),
          f: children = []
        });

        conditions.push(invert(child.x));
      } else if (child = readElse__readElse(parser, tag)) {
        if (section.n === SECTION_UNLESS) {
          parser.error("{{else}} not allowed in {{#unless}}");
        }

        if (hasElse) {
          parser.error("there can only be one {{else}} block, at the end of a section");
        }

        hasElse = true;

        // use an unless block if there's no elseif
        if (!unlessBlock) {
          unlessBlock = createUnlessBlock(expression, section.n);
          children = unlessBlock.f;
        } else {
          unlessBlock.f.push({
            t: SECTION,
            n: SECTION_IF,
            x: flattenExpression(readSection__combine(conditions)),
            f: children = []
          });
        }
      } else {
        child = parser.read();

        if (!child) {
          break;
        }

        children.push(child);
      }
    } while (!closed);

    if (unlessBlock) {
      // special case - `with` should become `if-with` (TODO is this right?
      // seems to me that `with` ought to behave consistently, regardless
      // of the presence/absence of `else`. In other words should always
      // be `if-with`
      if (section.n === SECTION_WITH) {
        section.n = SECTION_IF_WITH;
      }

      section.l = unlessBlock;
    }

    refineExpression(expression, section);

    // TODO if a section is empty it should be discarded. Don't do
    // that here though - we need to clean everything up first, as
    // it may contain removeable whitespace. As a temporary measure,
    // to pass the existing tests, remove empty `f` arrays
    if (!section.f.length) {
      delete section.f;
    }

    return section;
  }

  function createUnlessBlock(expression, sectionType) {
    var unlessBlock;

    if (sectionType === SECTION_WITH) {
      // special case - a `{{#with foo}}` section will render if `foo` is
      // truthy, so the `{{else}}` section needs to render if `foo` is falsy,
      // rather than adhering to the normal `{{#unless foo}}` logic (which
      // treats empty arrays/objects as falsy)
      unlessBlock = {
        t: SECTION,
        n: SECTION_IF,
        f: []
      };

      refineExpression(invert(expression), unlessBlock);
    } else {
      unlessBlock = {
        t: SECTION,
        n: SECTION_UNLESS,
        f: []
      };

      refineExpression(expression, unlessBlock);
    }

    return unlessBlock;
  }

  function invert(expression) {
    if (expression.t === PREFIX_OPERATOR && expression.s === "!") {
      return expression.o;
    }

    return {
      t: PREFIX_OPERATOR,
      s: "!",
      o: parensIfNecessary(expression)
    };
  }

  function readSection__combine(expressions) {
    if (expressions.length === 1) {
      return expressions[0];
    }

    return {
      t: INFIX_OPERATOR,
      s: "&&",
      o: [parensIfNecessary(expressions[0]), parensIfNecessary(readSection__combine(expressions.slice(1)))]
    };
  }

  function parensIfNecessary(expression) {
    // TODO only wrap if necessary
    return {
      t: BRACKETED,
      x: expression
    };
  }
  //# sourceMappingURL=02-6to5-readSection.js.map

  var OPEN_COMMENT = "<!--",
      CLOSE_COMMENT = "-->";

  function readHtmlComment(parser) {
    var start, content, remaining, endIndex, comment;

    start = parser.pos;

    if (!parser.matchString(OPEN_COMMENT)) {
      return null;
    }

    remaining = parser.remaining();
    endIndex = remaining.indexOf(CLOSE_COMMENT);

    if (endIndex === -1) {
      parser.error("Illegal HTML - expected closing comment sequence ('-->')");
    }

    content = remaining.substr(0, endIndex);
    parser.pos += endIndex + 3;

    comment = {
      t: COMMENT,
      c: content
    };

    if (parser.includeLinePositions) {
      comment.p = parser.getLinePos(start);
    }

    return comment;
  }
  //# sourceMappingURL=02-6to5-readHtmlComment.js.map

  var booleanAttributes, voidElementNames, htmlEntities, controlCharacters, entityPattern, lessThan, greaterThan, amp;

  // https://github.com/kangax/html-minifier/issues/63#issuecomment-37763316
  booleanAttributes = /^(allowFullscreen|async|autofocus|autoplay|checked|compact|controls|declare|default|defaultChecked|defaultMuted|defaultSelected|defer|disabled|draggable|enabled|formNoValidate|hidden|indeterminate|inert|isMap|itemScope|loop|multiple|muted|noHref|noResize|noShade|noValidate|noWrap|open|pauseOnExit|readOnly|required|reversed|scoped|seamless|selected|sortable|translate|trueSpeed|typeMustMatch|visible)$/i;
  voidElementNames = /^(?:area|base|br|col|command|doctype|embed|hr|img|input|keygen|link|meta|param|source|track|wbr)$/i;

  htmlEntities = { quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166, sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175, deg: 176, plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183, cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189, frac34: 190, iquest: 191, Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207, ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, times: 215, Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222, szlig: 223, agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231, egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239, eth: 240, ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, divide: 247, oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253, thorn: 254, yuml: 255, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Epsilon: 917, Zeta: 918, Eta: 919, Theta: 920, Iota: 921, Kappa: 922, Lambda: 923, Mu: 924, Nu: 925, Xi: 926, Omicron: 927, Pi: 928, Rho: 929, Sigma: 931, Tau: 932, Upsilon: 933, Phi: 934, Chi: 935, Psi: 936, Omega: 937, alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950, eta: 951, theta: 952, iota: 953, kappa: 954, lambda: 955, mu: 956, nu: 957, xi: 958, omicron: 959, pi: 960, rho: 961, sigmaf: 962, sigma: 963, tau: 964, upsilon: 965, phi: 966, chi: 967, psi: 968, omega: 969, thetasym: 977, upsih: 978, piv: 982, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465, weierp: 8472, real: 8476, trade: 8482, alefsym: 8501, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660, forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830 };
  controlCharacters = [8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143, 144, 8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376];
  entityPattern = new RegExp("&(#?(?:x[\\w\\d]+|\\d+|" + Object.keys(htmlEntities).join("|") + "));?", "g");

  function decodeCharacterReferences(html) {
    return html.replace(entityPattern, function (match, entity) {
      var code;

      // Handle named entities
      if (entity[0] !== "#") {
        code = htmlEntities[entity];
      } else if (entity[1] === "x") {
        code = parseInt(entity.substring(2), 16);
      } else {
        code = parseInt(entity.substring(1), 10);
      }

      if (!code) {
        return match;
      }

      return String.fromCharCode(validateCode(code));
    });
  }

  // some code points are verboten. If we were inserting HTML, the browser would replace the illegal
  // code points with alternatives in some cases - since we're bypassing that mechanism, we need
  // to replace them ourselves
  //
  // Source: http://en.wikipedia.org/wiki/Character_encodings_in_HTML#Illegal_characters
  function validateCode(code) {
    if (!code) {
      return 65533;
    }

    // line feed becomes generic whitespace
    if (code === 10) {
      return 32;
    }

    // ASCII range. (Why someone would use HTML entities for ASCII characters I don't know, but...)
    if (code < 128) {
      return code;
    }

    // code points 128-159 are dealt with leniently by browsers, but they're incorrect. We need
    // to correct the mistake or we'll end up with missing € signs and so on
    if (code <= 159) {
      return controlCharacters[code - 128];
    }

    // basic multilingual plane
    if (code < 55296) {
      return code;
    }

    // UTF-16 surrogate halves
    if (code <= 57343) {
      return 65533;
    }

    // rest of the basic multilingual plane
    if (code <= 65535) {
      return code;
    }

    return 65533;
  }

  lessThan = /</g;
  greaterThan = />/g;
  amp = /&/g;

  function escapeHtml(str) {
    return str.replace(amp, "&amp;").replace(lessThan, "&lt;").replace(greaterThan, "&gt;");
  }

  var closingTagPattern = /^([a-zA-Z]{1,}:?[a-zA-Z0-9\-]*)\s*\>/;

  function readClosingTag(parser) {
    var start, tag;

    start = parser.pos;

    // are we looking at a closing tag?
    if (!parser.matchString("</")) {
      return null;
    }

    if (tag = parser.matchPattern(closingTagPattern)) {
      if (parser.inside && tag !== parser.inside) {
        parser.pos = start;
        return null;
      }

      return {
        t: CLOSING_TAG,
        e: tag
      };
    }

    // We have an illegal closing tag, report it
    parser.pos -= 2;
    parser.error("Illegal closing tag");
  }
  //# sourceMappingURL=02-6to5-readClosingTag.js.map

  var getLowestIndex = function (haystack, needles) {
    var i, index, lowest;

    i = needles.length;
    while (i--) {
      index = haystack.indexOf(needles[i]);

      // short circuit
      if (!index) {
        return 0;
      }

      if (index === -1) {
        continue;
      }

      if (!lowest || index < lowest) {
        lowest = index;
      }
    }

    return lowest || -1;
  };
  //# sourceMappingURL=02-6to5-getLowestIndex.js.map

  var attributeNamePattern = /^[^\s"'>\/=]+/,
      unquotedAttributeValueTextPattern = /^[^\s"'=<>`]+/;

  function readAttribute(parser) {
    var attr, name, value;

    parser.allowWhitespace();

    name = parser.matchPattern(attributeNamePattern);
    if (!name) {
      return null;
    }

    attr = {
      name: name
    };

    value = readAttributeValue(parser);
    if (value) {
      attr.value = value;
    }

    return attr;
  }

  function readAttributeValue(parser) {
    var start, valueStart, startDepth, value;

    start = parser.pos;

    parser.allowWhitespace();

    if (!parser.matchString("=")) {
      parser.pos = start;
      return null;
    }

    parser.allowWhitespace();

    valueStart = parser.pos;
    startDepth = parser.sectionDepth;

    value = readQuotedAttributeValue(parser, "'") || readQuotedAttributeValue(parser, "\"") || readUnquotedAttributeValue(parser);

    if (parser.sectionDepth !== startDepth) {
      parser.pos = valueStart;
      parser.error("An attribute value must contain as many opening section tags as closing section tags");
    }

    if (value === null) {
      parser.pos = start;
      return null;
    }

    if (!value.length) {
      return null;
    }

    if (value.length === 1 && typeof value[0] === "string") {
      return decodeCharacterReferences(value[0]);
    }

    return value;
  }

  function readUnquotedAttributeValueToken(parser) {
    var start, text, haystack, needles, index;

    start = parser.pos;

    text = parser.matchPattern(unquotedAttributeValueTextPattern);

    if (!text) {
      return null;
    }

    haystack = text;
    needles = parser.tags.map(function (t) {
      return t.open;
    }); // TODO refactor... we do this in readText.js as well

    if ((index = getLowestIndex(haystack, needles)) !== -1) {
      text = text.substr(0, index);
      parser.pos = start + text.length;
    }

    return text;
  }

  function readUnquotedAttributeValue(parser) {
    var tokens, token;

    parser.inAttribute = true;

    tokens = [];

    token = readMustache(parser) || readUnquotedAttributeValueToken(parser);
    while (token !== null) {
      tokens.push(token);
      token = readMustache(parser) || readUnquotedAttributeValueToken(parser);
    }

    if (!tokens.length) {
      return null;
    }

    parser.inAttribute = false;
    return tokens;
  }

  function readQuotedAttributeValue(parser, quoteMark) {
    var start, tokens, token;

    start = parser.pos;

    if (!parser.matchString(quoteMark)) {
      return null;
    }

    parser.inAttribute = quoteMark;

    tokens = [];

    token = readMustache(parser) || readQuotedStringToken(parser, quoteMark);
    while (token !== null) {
      tokens.push(token);
      token = readMustache(parser) || readQuotedStringToken(parser, quoteMark);
    }

    if (!parser.matchString(quoteMark)) {
      parser.pos = start;
      return null;
    }

    parser.inAttribute = false;

    return tokens;
  }

  function readQuotedStringToken(parser, quoteMark) {
    var start, index, haystack, needles;

    start = parser.pos;
    haystack = parser.remaining();

    needles = parser.tags.map(function (t) {
      return t.open;
    }); // TODO refactor... we do this in readText.js as well
    needles.push(quoteMark);

    index = getLowestIndex(haystack, needles);

    if (index === -1) {
      parser.error("Quoted attribute value must have a closing quote");
    }

    if (!index) {
      return null;
    }

    parser.pos += index;
    return haystack.substr(0, index);
  }
  //# sourceMappingURL=02-6to5-readAttribute.js.map

  var JsonParser, specials, specialsPattern, parseJSON__numberPattern, placeholderPattern, placeholderAtStartPattern, onlyWhitespace;

  specials = {
    "true": true,
    "false": false,
    undefined: undefined,
    "null": null
  };

  specialsPattern = new RegExp("^(?:" + Object.keys(specials).join("|") + ")");
  parseJSON__numberPattern = /^(?:[+-]?)(?:(?:(?:0|[1-9]\d*)?\.\d+)|(?:(?:0|[1-9]\d*)\.)|(?:0|[1-9]\d*))(?:[eE][+-]?\d+)?/;
  placeholderPattern = /\$\{([^\}]+)\}/g;
  placeholderAtStartPattern = /^\$\{([^\}]+)\}/;
  onlyWhitespace = /^\s*$/;

  JsonParser = Parser.extend({
    init: function (str, options) {
      this.values = options.values;
      this.allowWhitespace();
    },

    postProcess: function (result) {
      if (result.length !== 1 || !onlyWhitespace.test(this.leftover)) {
        return null;
      }

      return { value: result[0].v };
    },

    converters: [function getPlaceholder(parser) {
      var placeholder;

      if (!parser.values) {
        return null;
      }

      placeholder = parser.matchPattern(placeholderAtStartPattern);

      if (placeholder && parser.values.hasOwnProperty(placeholder)) {
        return { v: parser.values[placeholder] };
      }
    }, function getSpecial(parser) {
      var special;

      if (special = parser.matchPattern(specialsPattern)) {
        return { v: specials[special] };
      }
    }, function getNumber(parser) {
      var number;

      if (number = parser.matchPattern(parseJSON__numberPattern)) {
        return { v: +number };
      }
    }, function getString(parser) {
      var stringLiteral = readStringLiteral(parser),
          values;

      if (stringLiteral && (values = parser.values)) {
        return {
          v: stringLiteral.v.replace(placeholderPattern, function (match, $1) {
            return $1 in values ? values[$1] : $1;
          })
        };
      }

      return stringLiteral;
    }, function getObject(parser) {
      var result, pair;

      if (!parser.matchString("{")) {
        return null;
      }

      result = {};

      parser.allowWhitespace();

      if (parser.matchString("}")) {
        return { v: result };
      }

      while (pair = getKeyValuePair(parser)) {
        result[pair.key] = pair.value;

        parser.allowWhitespace();

        if (parser.matchString("}")) {
          return { v: result };
        }

        if (!parser.matchString(",")) {
          return null;
        }
      }

      return null;
    }, function getArray(parser) {
      var result, valueToken;

      if (!parser.matchString("[")) {
        return null;
      }

      result = [];

      parser.allowWhitespace();

      if (parser.matchString("]")) {
        return { v: result };
      }

      while (valueToken = parser.read()) {
        result.push(valueToken.v);

        parser.allowWhitespace();

        if (parser.matchString("]")) {
          return { v: result };
        }

        if (!parser.matchString(",")) {
          return null;
        }

        parser.allowWhitespace();
      }

      return null;
    }]
  });

  function getKeyValuePair(parser) {
    var key, valueToken, pair;

    parser.allowWhitespace();

    key = readKey(parser);

    if (!key) {
      return null;
    }

    pair = { key: key };

    parser.allowWhitespace();
    if (!parser.matchString(":")) {
      return null;
    }
    parser.allowWhitespace();

    valueToken = parser.read();
    if (!valueToken) {
      return null;
    }

    pair.value = valueToken.v;

    return pair;
  }

  var parseJSON = function (str, values) {
    var parser = new JsonParser(str, {
      values: values
    });

    return parser.result;
  };
  //# sourceMappingURL=02-6to5-parseJSON.js.map

  var methodCallPattern = /^([a-zA-Z_$][a-zA-Z_$0-9]*)\(/,
      ExpressionParser;

  ExpressionParser = Parser.extend({
    converters: [readExpression]
  });

  // TODO clean this up, it's shocking
  function processDirective(tokens) {
    var result, match, parser, args, token, colonIndex, directiveName, directiveArgs, parsed;

    if (typeof tokens === "string") {
      if (match = methodCallPattern.exec(tokens)) {
        result = { m: match[1] };
        args = "[" + tokens.slice(result.m.length + 1, -1) + "]";

        parser = new ExpressionParser(args);
        result.a = flattenExpression(parser.result[0]);

        return result;
      }

      if (tokens.indexOf(":") === -1) {
        return tokens.trim();
      }

      tokens = [tokens];
    }

    result = {};

    directiveName = [];
    directiveArgs = [];

    if (tokens) {
      while (tokens.length) {
        token = tokens.shift();

        if (typeof token === "string") {
          colonIndex = token.indexOf(":");

          if (colonIndex === -1) {
            directiveName.push(token);
          } else {
            // is the colon the first character?
            if (colonIndex) {
              // no
              directiveName.push(token.substr(0, colonIndex));
            }

            // if there is anything after the colon in this token, treat
            // it as the first token of the directiveArgs fragment
            if (token.length > colonIndex + 1) {
              directiveArgs[0] = token.substring(colonIndex + 1);
            }

            break;
          }
        } else {
          directiveName.push(token);
        }
      }

      directiveArgs = directiveArgs.concat(tokens);
    }

    if (!directiveName.length) {
      result = "";
    } else if (directiveArgs.length || typeof directiveName !== "string") {
      result = {
        // TODO is this really necessary? just use the array
        n: directiveName.length === 1 && typeof directiveName[0] === "string" ? directiveName[0] : directiveName
      };

      if (directiveArgs.length === 1 && typeof directiveArgs[0] === "string") {
        parsed = parseJSON("[" + directiveArgs[0] + "]");
        result.a = parsed ? parsed.value : directiveArgs[0].trim();
      } else {
        result.d = directiveArgs;
      }
    } else {
      result = directiveName;
    }

    return result;
  }
  //# sourceMappingURL=02-6to5-processDirective.js.map

  var tagNamePattern = /^[a-zA-Z]{1,}:?[a-zA-Z0-9\-]*/,
      validTagNameFollower = /^[\s\n\/>]/,
      onPattern = /^on/,
      proxyEventPattern = /^on-([a-zA-Z\\*\\.$_][a-zA-Z\\*\\.$_0-9\-]+)$/,
      reservedEventNames = /^(?:change|reset|teardown|update|construct|config|init|render|unrender|detach|insert)$/,
      directives = { "intro-outro": "t0", intro: "t1", outro: "t2", decorator: "o" },
      exclude = { exclude: true },
      disallowedContents;

  // based on http://developers.whatwg.org/syntax.html#syntax-tag-omission
  disallowedContents = {
    li: ["li"],
    dt: ["dt", "dd"],
    dd: ["dt", "dd"],
    p: "address article aside blockquote div dl fieldset footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul".split(" "),
    rt: ["rt", "rp"],
    rp: ["rt", "rp"],
    optgroup: ["optgroup"],
    option: ["option", "optgroup"],
    thead: ["tbody", "tfoot"],
    tbody: ["tbody", "tfoot"],
    tfoot: ["tbody"],
    tr: ["tr", "tbody"],
    td: ["td", "th", "tr"],
    th: ["td", "th", "tr"]
  };



  function readElement(parser) {
    var start, element, lowerCaseName, directiveName, match, addProxyEvent, attribute, directive, selfClosing, children, child, closed, pos;

    start = parser.pos;

    if (parser.inside || parser.inAttribute) {
      return null;
    }

    if (!parser.matchString("<")) {
      return null;
    }

    // if this is a closing tag, abort straight away
    if (parser.nextChar() === "/") {
      return null;
    }

    element = {};
    if (parser.includeLinePositions) {
      element.p = parser.getLinePos(start);
    }

    if (parser.matchString("!")) {
      element.t = DOCTYPE;
      if (!parser.matchPattern(/^doctype/i)) {
        parser.error("Expected DOCTYPE declaration");
      }

      element.a = parser.matchPattern(/^(.+?)>/);
      return element;
    }

    element.t = ELEMENT;

    // element name
    element.e = parser.matchPattern(tagNamePattern);
    if (!element.e) {
      return null;
    }

    // next character must be whitespace, closing solidus or '>'
    if (!validTagNameFollower.test(parser.nextChar())) {
      parser.error("Illegal tag name");
    }

    addProxyEvent = function (name, directive) {
      var directiveName = directive.n || directive;

      if (reservedEventNames.test(directiveName)) {
        parser.pos -= directiveName.length;
        parser.error("Cannot use reserved event names (change, reset, teardown, update, construct, config, init, render, unrender, detach, insert)");
      }

      element.v[name] = directive;
    };

    parser.allowWhitespace();

    // directives and attributes
    while (attribute = readMustache(parser) || readAttribute(parser)) {
      // regular attributes
      if (attribute.name) {
        // intro, outro, decorator
        if (directiveName = directives[attribute.name]) {
          element[directiveName] = processDirective(attribute.value);
        }

        // on-click etc
        else if (match = proxyEventPattern.exec(attribute.name)) {
          if (!element.v) element.v = {};
          directive = processDirective(attribute.value);
          addProxyEvent(match[1], directive);
        } else {
          if (!parser.sanitizeEventAttributes || !onPattern.test(attribute.name)) {
            if (!element.a) element.a = {};
            element.a[attribute.name] = attribute.value || 0;
          }
        }
      }

      // {{#if foo}}class='foo'{{/if}}
      else {
        if (!element.m) element.m = [];
        element.m.push(attribute);
      }

      parser.allowWhitespace();
    }

    // allow whitespace before closing solidus
    parser.allowWhitespace();

    // self-closing solidus?
    if (parser.matchString("/")) {
      selfClosing = true;
    }

    // closing angle bracket
    if (!parser.matchString(">")) {
      return null;
    }

    lowerCaseName = element.e.toLowerCase();

    if (!selfClosing && !voidElementNames.test(element.e)) {
      // Special case - if we open a script element, further tags should
      // be ignored unless they're a closing script element
      if (lowerCaseName === "script" || lowerCaseName === "style") {
        parser.inside = lowerCaseName;
      }

      children = [];

      do {
        pos = parser.pos;

        if (!canContain(lowerCaseName, parser.remaining())) {
          closed = true;
        } else if (child = readClosingTag(parser)) {
          // TODO verify that this tag can close this element (is either the same, or
          // a parent that can close child elements implicitly)

          //parser.error( 'Expected closing </' + element.e + '> tag' );
          closed = true;
        }

        // implicit close by closing section tag. TODO clean this up
        else if (child = readClosing(parser, { open: parser.standardDelimiters[0], close: parser.standardDelimiters[1] })) {
          closed = true;
          parser.pos = pos;
        } else {
          child = parser.read();

          if (!child) {
            closed = true;
          } else {
            children.push(child);
          }
        }
      } while (!closed);

      if (children.length) {
        element.f = children;
      }
    }

    parser.inside = null;

    if (parser.sanitizeElements && parser.sanitizeElements.indexOf(lowerCaseName) !== -1) {
      return exclude;
    }

    return element;
  }

  function canContain(name, remaining) {
    var match, disallowed;

    match = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(remaining);
    disallowed = disallowedContents[name];

    if (!match || !disallowed) {
      return true;
    }

    return ! ~disallowed.indexOf(match[1].toLowerCase());
  }
  //# sourceMappingURL=02-6to5-readElement.js.map

  var escapeRegExp__pattern = /[-/\\^$*+?.()|[\]{}]/g;

  function escapeRegExp(str) {
    return str.replace(escapeRegExp__pattern, "\\$&");
  }
  //# sourceMappingURL=02-6to5-escapeRegExp.js.map

  var startPattern = /^<!--\s*/,
      namePattern = /s*>\s*([a-zA-Z_$][-a-zA-Z_$0-9]*)\s*/,
      finishPattern = /\s*-->/,
      closed,
      child;

  function readPartialDefinitionComment(parser) {
    var firstPos = parser.pos,
        open = parser.standardDelimiters[0],
        close = parser.standardDelimiters[1],
        content = undefined;

    if (!parser.matchPattern(startPattern) || !parser.matchString(open)) {
      parser.pos = firstPos;
      return null;
    }

    var name = parser.matchPattern(namePattern);

    // make sure the rest of the comment is in the correct place
    if (!parser.matchString(close) || !parser.matchPattern(finishPattern)) {
      parser.pos = firstPos;
      return null;
    }

    content = [];

    var endPattern = new RegExp("^<!--\\s*" + escapeRegExp(open) + "\\s*\\/\\s*" + name + "\\s*" + escapeRegExp(close) + "\\s*-->");

    do {
      if (parser.matchPattern(endPattern)) {
        closed = true;
      } else {
        child = parser.read();
        if (!child) {
          parser.error("expected closing comment ('<!-- " + open + "/" + name + "" + close + " -->')");
        }

        content.push(child);
      }
    } while (!closed);

    return {
      t: INLINE_PARTIAL,
      f: content,
      n: name
    };
  }
  //# sourceMappingURL=02-6to5-readPartialDefinitionComment.js.map

  function readText(parser) {
    var index, remaining, disallowed, barrier;

    remaining = parser.remaining();

    barrier = parser.inside ? "</" + parser.inside : "<";

    if (parser.inside && !parser.interpolate[parser.inside]) {
      index = remaining.indexOf(barrier);
    } else {
      disallowed = parser.tags.map(function (t) {
        return t.open;
      });

      // http://developers.whatwg.org/syntax.html#syntax-attributes
      if (parser.inAttribute === true) {
        // we're inside an unquoted attribute value
        disallowed.push("\"", "'", "=", "<", ">", "`");
      } else if (parser.inAttribute) {
        // quoted attribute value
        disallowed.push(parser.inAttribute);
      } else {
        disallowed.push(barrier);
      }

      index = getLowestIndex(remaining, disallowed);
    }

    if (!index) {
      return null;
    }

    if (index === -1) {
      index = remaining.length;
    }

    parser.pos += index;

    return parser.inside ? remaining.substr(0, index) : decodeCharacterReferences(remaining.substr(0, index));
  }
  //# sourceMappingURL=02-6to5-readText.js.map

  var trimWhitespace__leadingWhitespace = /^[ \t\f\r\n]+/,
      trimWhitespace__trailingWhitespace = /[ \t\f\r\n]+$/;

  var trimWhitespace = function (items, leading, trailing) {
    var item;

    if (leading) {
      item = items[0];
      if (typeof item === "string") {
        item = item.replace(trimWhitespace__leadingWhitespace, "");

        if (!item) {
          items.shift();
        } else {
          items[0] = item;
        }
      }
    }

    if (trailing) {
      item = lastItem(items);
      if (typeof item === "string") {
        item = item.replace(trimWhitespace__trailingWhitespace, "");

        if (!item) {
          items.pop();
        } else {
          items[items.length - 1] = item;
        }
      }
    }
  };
  //# sourceMappingURL=02-6to5-trimWhitespace.js.map

  var leadingLinebreak = /^\s*\r?\n/,
      trailingLinebreak = /\r?\n\s*$/;

  var stripStandalones = function (items) {
    var i, current, backOne, backTwo, lastSectionItem;

    for (i = 1; i < items.length; i += 1) {
      current = items[i];
      backOne = items[i - 1];
      backTwo = items[i - 2];

      // if we're at the end of a [text][comment][text] sequence...
      if (isString(current) && isComment(backOne) && isString(backTwo)) {
        // ... and the comment is a standalone (i.e. line breaks either side)...
        if (trailingLinebreak.test(backTwo) && leadingLinebreak.test(current)) {
          // ... then we want to remove the whitespace after the first line break
          items[i - 2] = backTwo.replace(trailingLinebreak, "\n");

          // and the leading line break of the second text token
          items[i] = current.replace(leadingLinebreak, "");
        }
      }

      // if the current item is a section, and it is preceded by a linebreak, and
      // its first item is a linebreak...
      if (isSection(current) && isString(backOne)) {
        if (trailingLinebreak.test(backOne) && isString(current.f[0]) && leadingLinebreak.test(current.f[0])) {
          items[i - 1] = backOne.replace(trailingLinebreak, "\n");
          current.f[0] = current.f[0].replace(leadingLinebreak, "");
        }
      }

      // if the last item was a section, and it is followed by a linebreak, and
      // its last item is a linebreak...
      if (isString(current) && isSection(backOne)) {
        lastSectionItem = lastItem(backOne.f);

        if (isString(lastSectionItem) && trailingLinebreak.test(lastSectionItem) && leadingLinebreak.test(current)) {
          backOne.f[backOne.f.length - 1] = lastSectionItem.replace(trailingLinebreak, "\n");
          items[i] = current.replace(leadingLinebreak, "");
        }
      }
    }

    return items;
  };

  function isString(item) {
    return typeof item === "string";
  }

  function isComment(item) {
    return item.t === COMMENT || item.t === DELIMCHANGE;
  }

  function isSection(item) {
    return (item.t === SECTION || item.t === INVERTED) && item.f;
  }
  //# sourceMappingURL=02-6to5-stripStandalones.js.map

  var processPartials = process;

  function process(path, target, items) {
    var i = items.length,
        item = undefined,
        cmp = undefined;

    while (i--) {
      item = items[i];

      if (isPartial(item)) {
        target[item.n] = item.f;
        items.splice(i, 1);
      } else if (isArray(item.f)) {
        if (cmp = processPartials__getComponent(path, item)) {
          path.push(cmp);
          process(path, item.p = {}, item.f);
          path.pop();
        } else if (isArray(item.f)) {
          process(path, target, item.f);
        }
      }
    }
  }

  function isPartial(item) {
    return item.t === INLINE_PARTIAL;
  }

  function processPartials__getComponent(path, item) {
    var i,
        cmp,
        name = item.e;

    if (item.e) {
      for (i = 0; i < path.length; i++) {
        if (cmp = (path[i].components || {})[name]) {
          return cmp;
        }
      }
    }
  }
  //# sourceMappingURL=02-6to5-processPartials.js.map

  var StandardParser,
      parse,
      contiguousWhitespace = /[ \t\f\r\n]+/g,
      preserveWhitespaceElements = /^(?:pre|script|style|textarea)$/i,
      parse__leadingWhitespace = /^\s+/,
      parse__trailingWhitespace = /\s+$/,
      STANDARD_READERS = [readPartial, readUnescaped, readPartialDefinitionSection, readSection, readYielder, readInterpolator, readComment],
      TRIPLE_READERS = [readTriple],
      STATIC_READERS = [readUnescaped, readSection, readInterpolator]; // TODO does it make sense to have a static section?

  StandardParser = Parser.extend({
    init: function parse__init(str, options) {
      var tripleDelimiters = options.tripleDelimiters || ["{{{", "}}}"],
          staticDelimiters = options.staticDelimiters || ["[[", "]]"],
          staticTripleDelimiters = options.staticTripleDelimiters || ["[[[", "]]]"];

      this.standardDelimiters = options.delimiters || ["{{", "}}"];

      this.tags = [{ isStatic: false, isTriple: false, open: this.standardDelimiters[0], close: this.standardDelimiters[1], readers: STANDARD_READERS }, { isStatic: false, isTriple: true, open: tripleDelimiters[0], close: tripleDelimiters[1], readers: TRIPLE_READERS }, { isStatic: true, isTriple: false, open: staticDelimiters[0], close: staticDelimiters[1], readers: STATIC_READERS }, { isStatic: true, isTriple: true, open: staticTripleDelimiters[0], close: staticTripleDelimiters[1], readers: TRIPLE_READERS }];

      this.sortMustacheTags();

      this.sectionDepth = 0;

      this.interpolate = {
        script: !options.interpolate || options.interpolate.script !== false,
        style: !options.interpolate || options.interpolate.style !== false
      };

      if (options.sanitize === true) {
        options.sanitize = {
          // blacklist from https://code.google.com/p/google-caja/source/browse/trunk/src/com/google/caja/lang/html/html4-elements-whitelist.json
          elements: "applet base basefont body frame frameset head html isindex link meta noframes noscript object param script style title".split(" "),
          eventAttributes: true
        };
      }

      this.sanitizeElements = options.sanitize && options.sanitize.elements;
      this.sanitizeEventAttributes = options.sanitize && options.sanitize.eventAttributes;
      this.includeLinePositions = options.includeLinePositions;
    },

    postProcess: function postProcess(items, options) {
      if (this.sectionDepth > 0) {
        this.error("A section was left open");
      }

      cleanup(items, options.stripComments !== false, options.preserveWhitespace, !options.preserveWhitespace, !options.preserveWhitespace);

      return items;
    },

    converters: [readMustache, readPartialDefinitionComment, readHtmlComment, readElement, readText],

    sortMustacheTags: function sortMustacheTags() {
      // Sort in order of descending opening delimiter length (longer first),
      // to protect against opening delimiters being substrings of each other
      this.tags.sort(function (a, b) {
        return b.open.length - a.open.length;
      });
    }
  });

  parse = function (template) {
    var options = arguments[1] === undefined ? {} : arguments[1];
    var result;

    result = {
      v: TEMPLATE_VERSION, // template spec version, defined in https://github.com/ractivejs/template-spec
      t: new StandardParser(template, options).result
    };

    // collect all of the partials and stick them on the appropriate instances
    var partials = {};
    // without a ractive instance, no components will be found
    processPartials(options.ractive ? [options.ractive] : [], partials, result.t);

    if (!isEmptyObject(partials)) {
      result.p = partials;
    }

    return result;
  };



  function cleanup(items, stripComments, preserveWhitespace, removeLeadingWhitespace, removeTrailingWhitespace) {
    var i, item, previousItem, nextItem, preserveWhitespaceInsideFragment, removeLeadingWhitespaceInsideFragment, removeTrailingWhitespaceInsideFragment, key;

    // First pass - remove standalones and comments etc
    stripStandalones(items);

    i = items.length;
    while (i--) {
      item = items[i];

      // Remove delimiter changes, unsafe elements etc
      if (item.exclude) {
        items.splice(i, 1);
      }

      // Remove comments, unless we want to keep them
      else if (stripComments && item.t === COMMENT) {
        items.splice(i, 1);
      }
    }

    // If necessary, remove leading and trailing whitespace
    trimWhitespace(items, removeLeadingWhitespace, removeTrailingWhitespace);

    i = items.length;
    while (i--) {
      item = items[i];

      // Recurse
      if (item.f) {
        preserveWhitespaceInsideFragment = preserveWhitespace || item.t === ELEMENT && preserveWhitespaceElements.test(item.e);

        if (!preserveWhitespaceInsideFragment) {
          previousItem = items[i - 1];
          nextItem = items[i + 1];

          // if the previous item was a text item with trailing whitespace,
          // remove leading whitespace inside the fragment
          if (!previousItem || typeof previousItem === "string" && parse__trailingWhitespace.test(previousItem)) {
            removeLeadingWhitespaceInsideFragment = true;
          }

          // and vice versa
          if (!nextItem || typeof nextItem === "string" && parse__leadingWhitespace.test(nextItem)) {
            removeTrailingWhitespaceInsideFragment = true;
          }
        }

        cleanup(item.f, stripComments, preserveWhitespaceInsideFragment, removeLeadingWhitespaceInsideFragment, removeTrailingWhitespaceInsideFragment);
      }

      // Split if-else blocks into two (an if, and an unless)
      if (item.l) {
        cleanup(item.l.f, stripComments, preserveWhitespace, removeLeadingWhitespaceInsideFragment, removeTrailingWhitespaceInsideFragment);

        items.splice(i + 1, 0, item.l);
        delete item.l; // TODO would be nice if there was a way around this
      }

      // Clean up element attributes
      if (item.a) {
        for (key in item.a) {
          if (item.a.hasOwnProperty(key) && typeof item.a[key] !== "string") {
            cleanup(item.a[key], stripComments, preserveWhitespace, removeLeadingWhitespaceInsideFragment, removeTrailingWhitespaceInsideFragment);
          }
        }
      }

      // Clean up conditional attributes
      if (item.m) {
        cleanup(item.m, stripComments, preserveWhitespace, removeLeadingWhitespaceInsideFragment, removeTrailingWhitespaceInsideFragment);
      }

      // Clean up event handlers
      if (item.v) {
        for (key in item.v) {
          if (item.v.hasOwnProperty(key)) {
            // clean up names
            if (isArray(item.v[key].n)) {
              cleanup(item.v[key].n, stripComments, preserveWhitespace, removeLeadingWhitespaceInsideFragment, removeTrailingWhitespaceInsideFragment);
            }

            // clean up params
            if (isArray(item.v[key].d)) {
              cleanup(item.v[key].d, stripComments, preserveWhitespace, removeLeadingWhitespaceInsideFragment, removeTrailingWhitespaceInsideFragment);
            }
          }
        }
      }
    }

    // final pass - fuse text nodes together
    i = items.length;
    while (i--) {
      if (typeof items[i] === "string") {
        if (typeof items[i + 1] === "string") {
          items[i] = items[i] + items[i + 1];
          items.splice(i + 1, 1);
        }

        if (!preserveWhitespace) {
          items[i] = items[i].replace(contiguousWhitespace, " ");
        }

        if (items[i] === "") {
          items.splice(i, 1);
        }
      }
    }
  }
  //# sourceMappingURL=02-6to5-_parse.js.map

  var parseOptions = ["preserveWhitespace", "sanitize", "stripComments", "delimiters", "tripleDelimiters", "interpolate"];

  var parser = {
    parse: doParse,
    fromId: fromId,
    isHashedId: isHashedId,
    isParsed: isParsed,
    getParseOptions: getParseOptions,
    createHelper: parser__createHelper
  };

  function parser__createHelper(parseOptions) {
    var helper = create(parser);
    helper.parse = function (template, options) {
      return doParse(template, options || parseOptions);
    };
    return helper;
  }

  function doParse(template, parseOptions) {
    if (!parse) {
      throw new Error("Missing Ractive.parse - cannot parse template. Either preparse or use the version that includes the parser");
    }

    return parse(template, parseOptions || this.options);
  }

  function fromId(id, options) {
    var template;

    if (!isClient) {
      if (options && options.noThrow) {
        return;
      }
      throw new Error("Cannot retrieve template #" + id + " as Ractive is not running in a browser.");
    }

    if (isHashedId(id)) {
      id = id.substring(1);
    }

    if (!(template = document.getElementById(id))) {
      if (options && options.noThrow) {
        return;
      }
      throw new Error("Could not find template element with id #" + id);
    }

    if (template.tagName.toUpperCase() !== "SCRIPT") {
      if (options && options.noThrow) {
        return;
      }
      throw new Error("Template element with id #" + id + ", must be a <script> element");
    }

    return template.innerHTML;
  }

  function isHashedId(id) {
    return id && id.charAt(0) === "#"; // TODO what about `id[0]`, does that work everywhere?
  }

  function isParsed(template) {
    return !(typeof template === "string");
  }

  function getParseOptions(ractive) {
    // Could be Ractive or a Component
    if (ractive.defaults) {
      ractive = ractive.defaults;
    }

    return parseOptions.reduce(function (val, key) {
      val[key] = ractive[key];
      return val;
    }, { ractive: ractive });
  }

  var parser__default = parser;
  //# sourceMappingURL=02-6to5-parser.js.map

  var templateConfigurator = {
    name: "template",

    extend: function templateConfigurator__extend(Parent, proto, options) {
      var template;

      // only assign if exists
      if ("template" in options) {
        template = options.template;

        if (typeof template === "function") {
          proto.template = template;
        } else {
          proto.template = parseIfString(template, proto);
        }
      }
    },

    init: function templateConfigurator__init(Parent, ractive, options) {
      var template, fn;

      // TODO because of prototypal inheritance, we might just be able to use
      // ractive.template, and not bother passing through the Parent object.
      // At present that breaks the test mocks' expectations
      template = "template" in options ? options.template : Parent.prototype.template;

      if (typeof template === "function") {
        fn = template;
        template = getDynamicTemplate(ractive, fn);

        ractive._config.template = {
          fn: fn,
          result: template
        };
      }

      template = parseIfString(template, ractive);

      // TODO the naming of this is confusing - ractive.template refers to [...],
      // but Component.prototype.template refers to {v:1,t:[],p:[]}...
      // it's unnecessary, because the developer never needs to access
      // ractive.template
      ractive.template = template.t;

      if (template.p) {
        extendPartials(ractive.partials, template.p);
      }
    },

    reset: function (ractive) {
      var result = resetValue(ractive),
          parsed;

      if (result) {
        parsed = parseIfString(result, ractive);

        ractive.template = parsed.t;
        extendPartials(ractive.partials, parsed.p, true);

        return true;
      }
    }
  };

  function resetValue(ractive) {
    var initial = ractive._config.template,
        result;

    // If this isn't a dynamic template, there's nothing to do
    if (!initial || !initial.fn) {
      return;
    }

    result = getDynamicTemplate(ractive, initial.fn);

    // TODO deep equality check to prevent unnecessary re-rendering
    // in the case of already-parsed templates
    if (result !== initial.result) {
      initial.result = result;
      result = parseIfString(result, ractive);
      return result;
    }
  }

  function getDynamicTemplate(ractive, fn) {
    var helper = templateConfigurator__createHelper(parser__default.getParseOptions(ractive));
    return fn.call(ractive, ractive.data, helper);
  }

  function templateConfigurator__createHelper(parseOptions) {
    var helper = create(parser__default);
    helper.parse = function (template, options) {
      return parser__default.parse(template, options || parseOptions);
    };
    return helper;
  }

  function parseIfString(template, ractive) {
    if (typeof template === "string") {
      // ID of an element containing the template?
      if (template[0] === "#") {
        template = parser__default.fromId(template);
      }

      template = parse(template, parser__default.getParseOptions(ractive));
    }

    // Check we're using the correct version
    else if (template.v !== TEMPLATE_VERSION) {
      throw new Error("Mismatched template version (expected " + TEMPLATE_VERSION + ", got " + template.v + ") Please ensure you are using the latest version of Ractive.js in your build process as well as in your app");
    }

    return template;
  }

  function extendPartials(existingPartials, newPartials, overwrite) {
    if (!newPartials) return;

    // TODO there's an ambiguity here - we need to overwrite in the `reset()`
    // case, but not initially...

    for (var key in newPartials) {
      if (overwrite || !existingPartials.hasOwnProperty(key)) {
        existingPartials[key] = newPartials[key];
      }
    }
  }


  //# sourceMappingURL=02-6to5-template.js.map

  var registryNames, Registry, registries;

  registryNames = ["adaptors", "components", "computed", "decorators", "easing", "events", "interpolators", "partials", "transitions"];

  Registry = function (name, useDefaults) {
    this.name = name;
    this.useDefaults = useDefaults;
  };

  Registry.prototype = {
    constructor: Registry,

    extend: function (Parent, proto, options) {
      this.configure(this.useDefaults ? Parent.defaults : Parent, this.useDefaults ? proto : proto.constructor, options);
    },

    init: function (Parent, ractive, options) {
      this.configure(this.useDefaults ? Parent.defaults : Parent, ractive, options);
    },

    configure: function (Parent, target, options) {
      var name = this.name,
          option = options[name],
          registry;

      registry = create(Parent[name]);

      for (var key in option) {
        registry[key] = option[key];
      }

      target[name] = registry;
    },

    reset: function (ractive) {
      var registry = ractive[this.name];
      var changed = false;
      Object.keys(registry).forEach(function (key) {
        var item = registry[key];
        if (item._fn) {
          if (item._fn.isOwner) {
            registry[key] = item._fn;
          } else {
            delete registry[key];
          }
          changed = true;
        }
      });
      return changed;
    }
  };

  registries = registryNames.map(function (name) {
    return new Registry(name, name === "computed");
  });


  //# sourceMappingURL=02-6to5-registries.js.map

  function wrap(parent, name, method) {
    if (!/_super/.test(method)) {
      return method;
    }

    var wrapper = function wrapSuper() {
      var superMethod = getSuperMethod(wrapper._parent, name),
          hasSuper = ("_super" in this),
          oldSuper = this._super,
          result;

      this._super = superMethod;

      result = method.apply(this, arguments);

      if (hasSuper) {
        this._super = oldSuper;
      } else {
        delete this._super;
      }

      return result;
    };

    wrapper._parent = parent;
    wrapper._method = method;

    return wrapper;
  }

  function getSuperMethod(parent, name) {
    var value, method;

    if (name in parent) {
      value = parent[name];

      if (typeof value === "function") {
        method = value;
      } else {
        method = function returnValue() {
          return value;
        };
      }
    } else {
      method = noop;
    }

    return method;
  }
  //# sourceMappingURL=02-6to5-wrapPrototypeMethod.js.map

  function getMessage(deprecated, correct, isError) {
    return "options." + deprecated + " has been deprecated in favour of options." + correct + "." + (isError ? " You cannot specify both options, please use options." + correct + "." : "");
  }

  function deprecateOption(options, deprecatedOption, correct) {
    if (deprecatedOption in options) {
      if (!(correct in options)) {
        warn(getMessage(deprecatedOption, correct));
        options[correct] = options[deprecatedOption];
      } else {
        throw new Error(getMessage(deprecatedOption, correct, true));
      }
    }
  }

  function deprecate(options) {
    deprecateOption(options, "beforeInit", "onconstruct");
    deprecateOption(options, "init", "onrender");
    deprecateOption(options, "complete", "oncomplete");
    deprecateOption(options, "eventDefinitions", "events");

    // Using extend with Component instead of options,
    // like Human.extend( Spider ) means adaptors as a registry
    // gets copied to options. So we have to check if actually an array
    if (isArray(options.adaptors)) {
      deprecateOption(options, "adaptors", "adapt");
    }
  }
  //# sourceMappingURL=02-6to5-deprecate.js.map

  var config, order, defaultKeys, custom, isBlacklisted, isStandardKey;

  custom = {
    adapt: adaptConfigurator,
    css: cssConfigurator,
    data: dataConfigurator,
    template: templateConfigurator
  };

  defaultKeys = Object.keys(defaults);

  isStandardKey = makeObj(defaultKeys.filter(function (key) {
    return !custom[key];
  }));

  // blacklisted keys that we don't double extend
  isBlacklisted = makeObj(defaultKeys.concat(registries.map(function (r) {
    return r.name;
  })));

  order = [].concat(defaultKeys.filter(function (key) {
    return !registries[key] && !custom[key];
  }), registries, custom.data, custom.template, custom.css);

  config = {
    extend: function (Parent, proto, options) {
      return configure("extend", Parent, proto, options);
    },

    init: function (Parent, ractive, options) {
      return configure("init", Parent, ractive, options);
    },

    reset: function (ractive) {
      return order.filter(function (c) {
        return c.reset && c.reset(ractive);
      }).map(function (c) {
        return c.name;
      });
    },

    // this defines the order. TODO this isn't used anywhere in the codebase,
    // only in the test suite - should get rid of it
    order: order,

    // TODO kill this off
    getConstructTarget: function (ractive, options) {
      if (options.onconstruct) {
        // pretend this object literal is the ractive instance
        return {
          onconstruct: wrap(ractive, "onconstruct", options.onconstruct).bind(ractive),
          fire: ractive.fire.bind(ractive)
        };
      } else {
        return ractive;
      }
    }
  };

  function configure(method, Parent, target, options) {
    deprecate(options);

    for (var key in options) {
      if (isStandardKey[key]) {
        var value = options[key];

        if (typeof value === "function") {
          value = wrap(Parent.prototype, key, value);
        }

        target[key] = value;
      }
    }

    registries.forEach(function (registry) {
      registry[method](Parent, target, options);
    });

    adaptConfigurator[method](Parent, target, options);
    dataConfigurator[method](Parent, target, options);
    templateConfigurator[method](Parent, target, options);
    cssConfigurator[method](Parent, target, options);

    extendOtherMethods(Parent.prototype, target, options);
  }

  function extendOtherMethods(parent, target, options) {
    for (var key in options) {
      if (!isBlacklisted[key] && options.hasOwnProperty(key)) {
        var member = options[key];

        // if this is a method that overwrites a method, wrap it:
        if (typeof member === "function") {
          member = wrap(parent, key, member);
        }

        target[key] = member;
      }
    }
  }

  function makeObj(array) {
    var obj = {};
    array.forEach(function (x) {
      return obj[x] = true;
    });
    return obj;
  }


  //# sourceMappingURL=02-6to5-config.js.map

  function Fragment$bubble() {
    this.dirtyValue = this.dirtyArgs = true;

    if (this.bound && typeof this.owner.bubble === "function") {
      this.owner.bubble();
    }
  }
  //# sourceMappingURL=02-6to5-bubble.js.map

  function Fragment$detach() {
    var docFrag;

    if (this.items.length === 1) {
      return this.items[0].detach();
    }

    docFrag = document.createDocumentFragment();

    this.items.forEach(function (item) {
      var node = item.detach();

      // TODO The if {...} wasn't previously required - it is now, because we're
      // forcibly detaching everything to reorder sections after an update. That's
      // a non-ideal brute force approach, implemented to get all the tests to pass
      // - as soon as it's replaced with something more elegant, this should
      // revert to `docFrag.appendChild( item.detach() )`
      if (node) {
        docFrag.appendChild(node);
      }
    });

    return docFrag;
  }
  //# sourceMappingURL=02-6to5-detach.js.map

  function Fragment$find(selector) {
    var i, len, item, queryResult;

    if (this.items) {
      len = this.items.length;
      for (i = 0; i < len; i += 1) {
        item = this.items[i];

        if (item.find && (queryResult = item.find(selector))) {
          return queryResult;
        }
      }

      return null;
    }
  }
  //# sourceMappingURL=02-6to5-find.js.map

  function Fragment$findAll(selector, query) {
    var i, len, item;

    if (this.items) {
      len = this.items.length;
      for (i = 0; i < len; i += 1) {
        item = this.items[i];

        if (item.findAll) {
          item.findAll(selector, query);
        }
      }
    }

    return query;
  }
  //# sourceMappingURL=02-6to5-findAll.js.map

  function Fragment$findAllComponents(selector, query) {
    var i, len, item;

    if (this.items) {
      len = this.items.length;
      for (i = 0; i < len; i += 1) {
        item = this.items[i];

        if (item.findAllComponents) {
          item.findAllComponents(selector, query);
        }
      }
    }

    return query;
  }
  //# sourceMappingURL=02-6to5-findAllComponents.js.map

  function Fragment$findComponent(selector) {
    var len, i, item, queryResult;

    if (this.items) {
      len = this.items.length;
      for (i = 0; i < len; i += 1) {
        item = this.items[i];

        if (item.findComponent && (queryResult = item.findComponent(selector))) {
          return queryResult;
        }
      }

      return null;
    }
  }
  //# sourceMappingURL=02-6to5-findComponent.js.map

  function Fragment$findNextNode(item) {
    var index = item.index,
        node;

    if (this.items[index + 1]) {
      node = this.items[index + 1].firstNode();
    }

    // if this is the root fragment, and there are no more items,
    // it means we're at the end...
    else if (this.owner === this.root) {
      if (!this.owner.component) {
        // TODO but something else could have been appended to
        // this.root.el, no?
        node = null;
      }

      // ...unless this is a component
      else {
        node = this.owner.component.findNextNode();
      }
    } else {
      node = this.owner.findNextNode(this);
    }

    return node;
  }
  //# sourceMappingURL=02-6to5-findNextNode.js.map

  function Fragment$firstNode() {
    if (this.items && this.items[0]) {
      return this.items[0].firstNode();
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-firstNode.js.map

  function processItems(items, values, guid, counter) {
    counter = counter || 0;

    return items.map(function (item) {
      var placeholderId, wrapped, value;

      if (item.text) {
        return item.text;
      }

      if (item.fragments) {
        return item.fragments.map(function (fragment) {
          return processItems(fragment.items, values, guid, counter);
        }).join("");
      }

      placeholderId = guid + "-" + counter++;

      if (item.keypath && (wrapped = item.root.viewmodel.wrapped[item.keypath.str])) {
        value = wrapped.value;
      } else {
        value = item.getValue();
      }

      values[placeholderId] = value;

      return "${" + placeholderId + "}";
    }).join("");
  }
  //# sourceMappingURL=02-6to5-processItems.js.map

  function Fragment$getArgsList() {
    var values, source, parsed, result;

    if (this.dirtyArgs) {
      source = processItems(this.items, values = {}, this.root._guid);
      parsed = parseJSON("[" + source + "]", values);

      if (!parsed) {
        result = [this.toString()];
      } else {
        result = parsed.value;
      }

      this.argsList = result;
      this.dirtyArgs = false;
    }

    return this.argsList;
  }
  //# sourceMappingURL=02-6to5-getArgsList.js.map

  function Fragment$getNode() {
    var fragment = this;

    do {
      if (fragment.pElement) {
        return fragment.pElement.node;
      }
    } while (fragment = fragment.parent);

    return this.root.detached || this.root.el;
  }
  //# sourceMappingURL=02-6to5-getNode.js.map

  function Fragment$getValue() {
    var values, source, parsed, result;

    if (this.dirtyValue) {
      source = processItems(this.items, values = {}, this.root._guid);
      parsed = parseJSON(source, values);

      if (!parsed) {
        result = this.toString();
      } else {
        result = parsed.value;
      }

      this.value = result;
      this.dirtyValue = false;
    }

    return this.value;
  }
  //# sourceMappingURL=02-6to5-getValue.js.map

  var detach__default = function () {
    return detachNode(this.node);
  };
  //# sourceMappingURL=02-6to5-detach.js.map

  var Text = function (options) {
    this.type = TEXT;
    this.text = options.template;
  };

  Text.prototype = {
    detach: detach__default,

    firstNode: function Text__firstNode() {
      return this.node;
    },

    render: function Text__render() {
      if (!this.node) {
        this.node = document.createTextNode(this.text);
      }

      return this.node;
    },

    toString: function Text__toString(escape) {
      return escape ? escapeHtml(this.text) : this.text;
    },

    unrender: function Text__unrender(shouldDestroy) {
      if (shouldDestroy) {
        return this.detach();
      }
    }
  };


  //# sourceMappingURL=02-6to5-Text.js.map

  function unbind__unbind() {
    if (this.registered) {
      // this was registered as a dependant
      this.root.viewmodel.unregister(this.keypath, this);
    }

    if (this.resolver) {
      this.resolver.unbind();
    }
  }
  //# sourceMappingURL=02-6to5-unbind.js.map

  function Mustache$getValue() {
    return this.value;
  }
  //# sourceMappingURL=02-6to5-getValue.js.map

  var ReferenceResolver = function (owner, ref, callback) {
    var keypath;

    this.ref = ref;
    this.resolved = false;

    this.root = owner.root;
    this.parentFragment = owner.parentFragment;
    this.callback = callback;

    keypath = resolveRef(owner.root, ref, owner.parentFragment);
    if (keypath != undefined) {
      this.resolve(keypath);
    } else {
      runloop.addUnresolved(this);
    }
  };

  ReferenceResolver.prototype = {
    resolve: function (keypath) {
      if (this.keypath && !keypath) {
        // it was resolved, and now it's not. Can happen if e.g. `bar` in
        // `{{foo[bar]}}` becomes undefined
        runloop.addUnresolved(this);
      }

      this.resolved = true;

      this.keypath = keypath;
      this.callback(keypath);
    },

    forceResolution: function () {
      this.resolve(getKeypath(this.ref));
    },

    rebind: function (oldKeypath, newKeypath) {
      var keypath;

      if (this.keypath != undefined) {
        keypath = this.keypath.replace(oldKeypath, newKeypath);
        // was a new keypath created?
        if (keypath !== undefined) {
          // resolve it
          this.resolve(keypath);
        }
      }
    },

    unbind: function () {
      if (!this.resolved) {
        runloop.removeUnresolved(this);
      }
    }
  };



  //# sourceMappingURL=02-6to5-ReferenceResolver.js.map

  var SpecialResolver = function (owner, ref, callback) {
    this.parentFragment = owner.parentFragment;
    this.ref = ref;
    this.callback = callback;

    this.rebind();
  };

  var props = {
    "@keypath": { prefix: "c", prop: ["context"] },
    "@index": { prefix: "i", prop: ["index"] },
    "@key": { prefix: "k", prop: ["key", "index"] }
  };

  function getProp(target, prop) {
    var value;
    for (var i = 0; i < prop.prop.length; i++) {
      if ((value = target[prop.prop[i]]) !== undefined) {
        return value;
      }
    }
  }

  SpecialResolver.prototype = {
    rebind: function () {
      var ref = this.ref,
          fragment = this.parentFragment,
          prop = props[ref],
          value;

      if (!prop) {
        throw new Error("Unknown special reference \"" + ref + "\" - valid references are @index, @key and @keypath");
      }

      // have we already found the nearest parent?
      if (this.cached) {
        return this.callback(getKeypath("@" + prop.prefix + getProp(this.cached, prop)));
      }

      // special case for indices, which may cross component boundaries
      if (prop.prop.indexOf("index") !== -1 || prop.prop.indexOf("key") !== -1) {
        while (fragment) {
          if (fragment.owner.currentSubtype === SECTION_EACH && (value = getProp(fragment, prop)) !== undefined) {
            this.cached = fragment;

            fragment.registerIndexRef(this);

            return this.callback(getKeypath("@" + prop.prefix + value));
          }

          // watch for component boundaries
          if (!fragment.parent && fragment.owner && fragment.owner.component && fragment.owner.component.parentFragment && !fragment.owner.component.instance.isolated) {
            fragment = fragment.owner.component.parentFragment;
          } else {
            fragment = fragment.parent;
          }
        }
      } else {
        while (fragment) {
          if ((value = getProp(fragment, prop)) !== undefined) {
            return this.callback(getKeypath("@" + prop.prefix + value.str));
          }

          fragment = fragment.parent;
        }
      }
    },

    unbind: function () {
      if (this.cached) {
        this.cached.unregisterIndexRef(this);
      }
    }
  };


  //# sourceMappingURL=02-6to5-SpecialResolver.js.map

  var IndexResolver = function (owner, ref, callback) {
    this.parentFragment = owner.parentFragment;
    this.ref = ref;
    this.callback = callback;

    ref.ref.fragment.registerIndexRef(this);

    this.rebind();
  };

  IndexResolver.prototype = {
    rebind: function () {
      var index,
          ref = this.ref.ref;

      if (ref.ref.t === "k") {
        index = "k" + ref.fragment.key;
      } else {
        index = "i" + ref.fragment.index;
      }

      if (index !== undefined) {
        this.callback(getKeypath("@" + index));
      }
    },

    unbind: function () {
      this.ref.ref.fragment.unregisterIndexRef(this);
    }
  };


  //# sourceMappingURL=02-6to5-IndexResolver.js.map

  function findIndexRefs(fragment, refName) {
    var result = {},
        refs,
        fragRefs,
        ref,
        i,
        owner,
        hit = false;

    if (!refName) {
      result.refs = refs = {};
    }

    while (fragment) {
      if ((owner = fragment.owner) && (fragRefs = owner.indexRefs)) {
        // we're looking for a particular ref, and it's here
        if (refName && (ref = owner.getIndexRef(refName))) {
          result.ref = {
            fragment: fragment,
            ref: ref
          };
          return result;
        }

        // we're collecting refs up-tree
        else if (!refName) {
          for (i in fragRefs) {
            ref = fragRefs[i];

            // don't overwrite existing refs - they should shadow parents
            if (!refs[ref.n]) {
              hit = true;
              refs[ref.n] = {
                fragment: fragment,
                ref: ref
              };
            }
          }
        }
      }

      // watch for component boundaries
      if (!fragment.parent && fragment.owner && fragment.owner.component && fragment.owner.component.parentFragment && !fragment.owner.component.instance.isolated) {
        result.componentBoundary = true;
        fragment = fragment.owner.component.parentFragment;
      } else {
        fragment = fragment.parent;
      }
    }

    if (!hit) {
      return undefined;
    } else {
      return result;
    }
  }

  findIndexRefs.resolve = function findIndexRefs__resolve(indices) {
    var refs = {},
        k,
        ref;

    for (k in indices.refs) {
      ref = indices.refs[k];
      refs[ref.ref.n] = ref.ref.t === "k" ? ref.fragment.key : ref.fragment.index;
    }

    return refs;
  };
  //# sourceMappingURL=02-6to5-findIndexRefs.js.map

  function createReferenceResolver(owner, ref, callback) {
    var indexRef;

    if (ref.charAt(0) === "@") {
      return new SpecialResolver(owner, ref, callback);
    }

    if (indexRef = findIndexRefs(owner.parentFragment, ref)) {
      return new IndexResolver(owner, indexRef, callback);
    }

    return new ReferenceResolver(owner, ref, callback);
  }
  //# sourceMappingURL=02-6to5-createReferenceResolver.js.map

  var cache = {};

  function getFunctionFromString(str, i) {
    var fn, args;

    if (cache[str]) {
      return cache[str];
    }

    args = [];
    while (i--) {
      args[i] = "_" + i;
    }

    fn = new Function(args.join(","), "return(" + str + ")");

    cache[str] = fn;
    return fn;
  }
  //# sourceMappingURL=02-6to5-getFunctionFromString.js.map

  var ExpressionResolver,
      bind = Function.prototype.bind;

  ExpressionResolver = function (owner, parentFragment, expression, callback) {
    var _this = this;
    var ractive;

    ractive = owner.root;

    this.root = ractive;
    this.parentFragment = parentFragment;
    this.callback = callback;
    this.owner = owner;
    this.str = expression.s;
    this.keypaths = [];

    // Create resolvers for each reference
    this.pending = expression.r.length;
    this.refResolvers = expression.r.map(function (ref, i) {
      return createReferenceResolver(_this, ref, function (keypath) {
        _this.resolve(i, keypath);
      });
    });

    this.ready = true;
    this.bubble();
  };

  ExpressionResolver.prototype = {
    bubble: function ExpressionResolver__bubble() {
      if (!this.ready) {
        return;
      }

      this.uniqueString = getUniqueString(this.str, this.keypaths);
      this.keypath = createExpressionKeypath(this.uniqueString);

      this.createEvaluator();
      this.callback(this.keypath);
    },

    unbind: function ExpressionResolver__unbind() {
      var resolver;

      while (resolver = this.refResolvers.pop()) {
        resolver.unbind();
      }
    },

    resolve: function ExpressionResolver__resolve(index, keypath) {
      this.keypaths[index] = keypath;
      this.bubble();
    },

    createEvaluator: function createEvaluator() {
      var _this2 = this;
      var computation, valueGetters, signature, keypath, fn;

      keypath = this.keypath;
      computation = this.root.viewmodel.computations[keypath.str];

      // only if it doesn't exist yet!
      if (!computation) {
        fn = getFunctionFromString(this.str, this.refResolvers.length);

        valueGetters = this.keypaths.map(function (keypath) {
          var value;

          if (keypath === "undefined") {
            return function () {
              return undefined;
            };
          }

          // 'special' keypaths encode a value
          if (keypath.isSpecial) {
            value = keypath.value;
            return function () {
              return value;
            };
          }

          return function () {
            var value = _this2.root.viewmodel.get(keypath, { noUnwrap: true });
            if (typeof value === "function") {
              value = wrapFunction(value, _this2.root);
            }
            return value;
          };
        });

        signature = {
          deps: this.keypaths.filter(isValidDependency),
          get: function get() {
            var args = valueGetters.map(call);
            return fn.apply(null, args);
          }
        };

        computation = this.root.viewmodel.compute(keypath, signature);
      } else {
        this.root.viewmodel.mark(keypath);
      }
    },

    rebind: function ExpressionResolver__rebind(oldKeypath, newKeypath) {
      // TODO only bubble once, no matter how many references are affected by the rebind
      this.refResolvers.forEach(function (r) {
        return r.rebind(oldKeypath, newKeypath);
      });
    }
  };



  function call(value) {
    return value.call();
  }

  function getUniqueString(str, keypaths) {
    // get string that is unique to this expression
    return str.replace(/_([0-9]+)/g, function (match, $1) {
      var keypath, value;

      keypath = keypaths[$1];

      if (keypath === undefined) {
        return "undefined";
      }

      if (keypath.isSpecial) {
        value = keypath.value;
        return typeof value === "number" ? value : "\"" + value + "\"";
      }

      return keypath.str;
    });
  }

  function createExpressionKeypath(uniqueString) {
    // Sanitize by removing any periods or square brackets. Otherwise
    // we can't split the keypath into keys!
    // Remove asterisks too, since they mess with pattern observers
    return getKeypath("${" + uniqueString.replace(/[\.\[\]]/g, "-").replace(/\*/, "#MUL#") + "}");
  }

  function isValidDependency(keypath) {
    return keypath !== undefined && keypath[0] !== "@";
  }

  function wrapFunction(fn, ractive) {
    var wrapped, prop, key;

    if (fn.__ractive_nowrap) {
      return fn;
    }

    prop = "__ractive_" + ractive._guid;
    wrapped = fn[prop];

    if (wrapped) {
      return wrapped;
    } else if (/this/.test(fn.toString())) {
      defineProperty(fn, prop, {
        value: bind.call(fn, ractive),
        configurable: true
      });

      // Add properties/methods to wrapped function
      for (key in fn) {
        if (fn.hasOwnProperty(key)) {
          fn[prop][key] = fn[key];
        }
      }

      ractive._boundFunctions.push({
        fn: fn,
        prop: prop
      });

      return fn[prop];
    }

    defineProperty(fn, "__ractive_nowrap", {
      value: fn
    });

    return fn.__ractive_nowrap;
  }
  //# sourceMappingURL=02-6to5-ExpressionResolver.js.map

  var MemberResolver = function (template, resolver, parentFragment) {
    var _this = this;
    this.resolver = resolver;
    this.root = resolver.root;
    this.parentFragment = parentFragment;
    this.viewmodel = resolver.root.viewmodel;

    if (typeof template === "string") {
      this.value = template;
    }

    // Simple reference?
    else if (template.t === REFERENCE) {
      this.refResolver = createReferenceResolver(this, template.n, function (keypath) {
        _this.resolve(keypath);
      });
    }

    // Otherwise we have an expression in its own right
    else {
      new ExpressionResolver(resolver, parentFragment, template, function (keypath) {
        _this.resolve(keypath);
      });
    }
  };

  MemberResolver.prototype = {
    resolve: function (keypath) {
      if (this.keypath) {
        this.viewmodel.unregister(this.keypath, this);
      }

      this.keypath = keypath;
      this.value = this.viewmodel.get(keypath);

      this.bind();

      this.resolver.bubble();
    },

    bind: function () {
      this.viewmodel.register(this.keypath, this);
    },

    rebind: function (oldKeypath, newKeypath) {
      if (this.refResolver) {
        this.refResolver.rebind(oldKeypath, newKeypath);
      }
    },

    setValue: function (value) {
      this.value = value;
      this.resolver.bubble();
    },

    unbind: function () {
      if (this.keypath) {
        this.viewmodel.unregister(this.keypath, this);
      }

      if (this.refResolver) {
        this.refResolver.unbind();
      }
    },

    forceResolution: function () {
      if (this.refResolver) {
        this.refResolver.forceResolution();
      }
    }
  };


  //# sourceMappingURL=02-6to5-MemberResolver.js.map

  var ReferenceExpressionResolver = function (mustache, template, callback) {
    var _this = this;
    var ractive, ref, keypath, parentFragment;

    this.parentFragment = parentFragment = mustache.parentFragment;
    this.root = ractive = mustache.root;
    this.mustache = mustache;

    this.ref = ref = template.r;
    this.callback = callback;

    this.unresolved = [];

    // Find base keypath
    if (keypath = resolveRef(ractive, ref, parentFragment)) {
      this.base = keypath;
    } else {
      this.baseResolver = new ReferenceResolver(this, ref, function (keypath) {
        _this.base = keypath;
        _this.baseResolver = null;
        _this.bubble();
      });
    }

    // Find values for members, or mark them as unresolved
    this.members = template.m.map(function (template) {
      return new MemberResolver(template, _this, parentFragment);
    });

    this.ready = true;
    this.bubble(); // trigger initial resolution if possible
  };

  ReferenceExpressionResolver.prototype = {
    getKeypath: function () {
      var values = this.members.map(ReferenceExpressionResolver__getValue);

      if (!values.every(isDefined) || this.baseResolver) {
        return null;
      }

      return this.base.join(values.join("."));
    },

    bubble: function () {
      if (!this.ready || this.baseResolver) {
        return;
      }

      this.callback(this.getKeypath());
    },

    unbind: function () {
      this.members.forEach(methodCallers__unbind);
    },

    rebind: function (oldKeypath, newKeypath) {
      var changed;

      this.members.forEach(function (members) {
        if (members.rebind(oldKeypath, newKeypath)) {
          changed = true;
        }
      });

      if (changed) {
        this.bubble();
      }
    },

    forceResolution: function () {
      if (this.baseResolver) {
        this.base = getKeypath(this.ref);

        this.baseResolver.unbind();
        this.baseResolver = null;
      }

      this.members.forEach(forceResolution);
      this.bubble();
    }
  };

  function ReferenceExpressionResolver__getValue(member) {
    return member.value;
  }

  function isDefined(value) {
    return value != undefined;
  }

  function forceResolution(member) {
    member.forceResolution();
  }


  //# sourceMappingURL=02-6to5-ReferenceExpressionResolver.js.map

  function Mustache$init(mustache, options) {
    var resolve = function (keypath) {
      mustache.resolve(keypath);
    };

    var resolveAndRebindChildren = function (newKeypath) {
      var oldKeypath = mustache.keypath;

      if (newKeypath != oldKeypath) {
        mustache.resolve(newKeypath);

        if (oldKeypath !== undefined) {
          mustache.fragments && mustache.fragments.forEach(function (f) {
            f.rebind(oldKeypath, newKeypath);
          });
        }
      }
    };

    var ref, parentFragment, template;

    parentFragment = options.parentFragment;
    template = options.template;

    mustache.root = parentFragment.root;
    mustache.parentFragment = parentFragment;
    mustache.pElement = parentFragment.pElement;

    mustache.template = options.template;
    mustache.index = options.index || 0;
    mustache.isStatic = options.template.s;

    mustache.type = options.template.t;

    mustache.registered = false;

    // if this is a simple mustache, with a reference, we just need to resolve
    // the reference to a keypath
    if (ref = template.r) {
      mustache.resolver = createReferenceResolver(mustache, ref, resolve);
    }

    // if it's an expression, we have a bit more work to do
    if (options.template.x) {
      mustache.resolver = new ExpressionResolver(mustache, parentFragment, options.template.x, resolveAndRebindChildren);
    }

    if (options.template.rx) {
      mustache.resolver = new ReferenceExpressionResolver(mustache, options.template.rx, resolveAndRebindChildren);
    }

    // Special case - inverted sections
    if (mustache.template.n === SECTION_UNLESS && !mustache.hasOwnProperty("value")) {
      mustache.setValue(undefined);
    }
  }
  //# sourceMappingURL=02-6to5-initialise.js.map

  function Mustache$resolve(keypath) {
    var wasResolved, value, twowayBinding;

    // 'Special' keypaths, e.g. @foo or @7, encode a value
    if (keypath && keypath.isSpecial) {
      this.keypath = keypath;
      this.setValue(keypath.value);
      return;
    }

    // If we resolved previously, we need to unregister
    if (this.registered) {
      // undefined or null
      this.root.viewmodel.unregister(this.keypath, this);
      this.registered = false;

      wasResolved = true;
    }

    this.keypath = keypath;

    // If the new keypath exists, we need to register
    // with the viewmodel
    if (keypath != undefined) {
      // undefined or null
      value = this.root.viewmodel.get(keypath);
      this.root.viewmodel.register(keypath, this);

      this.registered = true;
    }

    // Either way we need to queue up a render (`value`
    // will be `undefined` if there's no keypath)
    this.setValue(value);

    // Two-way bindings need to point to their new target keypath
    if (wasResolved && (twowayBinding = this.twowayBinding)) {
      twowayBinding.rebound();
    }
  }
  //# sourceMappingURL=02-6to5-resolve.js.map

  function Mustache$rebind(oldKeypath, newKeypath) {
    // Children first
    if (this.fragments) {
      this.fragments.forEach(function (f) {
        return f.rebind(oldKeypath, newKeypath);
      });
    }

    // Expression mustache?
    if (this.resolver) {
      this.resolver.rebind(oldKeypath, newKeypath);
    }
  }
  //# sourceMappingURL=02-6to5-rebind.js.map

  var Mustache = {
    getValue: Mustache$getValue,
    init: Mustache$init,
    resolve: Mustache$resolve,
    rebind: Mustache$rebind
  };
  //# sourceMappingURL=02-6to5-_Mustache.js.map

  var Interpolator = function (options) {
    this.type = INTERPOLATOR;
    Mustache.init(this, options);
  };

  Interpolator.prototype = {
    update: function Interpolator__update() {
      this.node.data = this.value == undefined ? "" : this.value;
    },
    resolve: Mustache.resolve,
    rebind: Mustache.rebind,
    detach: detach__default,

    unbind: unbind__unbind,

    render: function Interpolator__render() {
      if (!this.node) {
        this.node = document.createTextNode(this.value != undefined ? this.value : "");
      }

      return this.node;
    },

    unrender: function Interpolator__unrender(shouldDestroy) {
      if (shouldDestroy) {
        detachNode(this.node);
      }
    },

    getValue: Mustache.getValue,

    // TEMP
    setValue: function Interpolator__setValue(value) {
      var wrapper;

      // TODO is there a better way to approach this?
      if (this.keypath && (wrapper = this.root.viewmodel.wrapped[this.keypath.str])) {
        value = wrapper.get();
      }

      if (!isEqual(value, this.value)) {
        this.value = value;
        this.parentFragment.bubble();

        if (this.node) {
          runloop.addView(this);
        }
      }
    },

    firstNode: function Interpolator__firstNode() {
      return this.node;
    },

    toString: function Interpolator__toString(escape) {
      var string = this.value != undefined ? "" + this.value : "";
      return escape ? escapeHtml(string) : string;
    }
  };


  //# sourceMappingURL=02-6to5-Interpolator.js.map

  function Section$bubble() {
    this.parentFragment.bubble();
  }
  //# sourceMappingURL=02-6to5-bubble.js.map

  function Section$detach() {
    var docFrag;

    if (this.fragments.length === 1) {
      return this.fragments[0].detach();
    }

    docFrag = document.createDocumentFragment();

    this.fragments.forEach(function (item) {
      docFrag.appendChild(item.detach());
    });

    return docFrag;
  }
  //# sourceMappingURL=02-6to5-detach.js.map

  function Section$find(selector) {
    var i, len, queryResult;

    len = this.fragments.length;
    for (i = 0; i < len; i += 1) {
      if (queryResult = this.fragments[i].find(selector)) {
        return queryResult;
      }
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-find.js.map

  function Section$findAll(selector, query) {
    var i, len;

    len = this.fragments.length;
    for (i = 0; i < len; i += 1) {
      this.fragments[i].findAll(selector, query);
    }
  }
  //# sourceMappingURL=02-6to5-findAll.js.map

  function Section$findAllComponents(selector, query) {
    var i, len;

    len = this.fragments.length;
    for (i = 0; i < len; i += 1) {
      this.fragments[i].findAllComponents(selector, query);
    }
  }
  //# sourceMappingURL=02-6to5-findAllComponents.js.map

  function Section$findComponent(selector) {
    var i, len, queryResult;

    len = this.fragments.length;
    for (i = 0; i < len; i += 1) {
      if (queryResult = this.fragments[i].findComponent(selector)) {
        return queryResult;
      }
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-findComponent.js.map

  function Section$findNextNode(fragment) {
    if (this.fragments[fragment.index + 1]) {
      return this.fragments[fragment.index + 1].firstNode();
    }

    return this.parentFragment.findNextNode(this);
  }
  //# sourceMappingURL=02-6to5-findNextNode.js.map

  function Section$firstNode() {
    var len, i, node;

    if (len = this.fragments.length) {
      for (i = 0; i < len; i += 1) {
        if (node = this.fragments[i].firstNode()) {
          return node;
        }
      }
    }

    return this.parentFragment.findNextNode(this);
  }
  //# sourceMappingURL=02-6to5-firstNode.js.map

  function Section$shuffle(newIndices) {
    var _this = this;
    var parentFragment, firstChange, i, newLength, reboundFragments, fragmentOptions, fragment;

    // short circuit any double-updates, and ensure that this isn't applied to
    // non-list sections
    if (this.shuffling || this.unbound || this.currentSubtype !== SECTION_EACH) {
      return;
    }

    this.shuffling = true;
    runloop.scheduleTask(function () {
      return _this.shuffling = false;
    });

    parentFragment = this.parentFragment;

    reboundFragments = [];

    // TODO: need to update this
    // first, rebind existing fragments
    newIndices.forEach(function (newIndex, oldIndex) {
      var fragment, by, oldKeypath, newKeypath, deps;

      if (newIndex === oldIndex) {
        reboundFragments[newIndex] = _this.fragments[oldIndex];
        return;
      }

      fragment = _this.fragments[oldIndex];

      if (firstChange === undefined) {
        firstChange = oldIndex;
      }

      // does this fragment need to be torn down?
      if (newIndex === -1) {
        _this.fragmentsToUnrender.push(fragment);
        fragment.unbind();
        return;
      }

      // Otherwise, it needs to be rebound to a new index
      by = newIndex - oldIndex;
      oldKeypath = _this.keypath.join(oldIndex);
      newKeypath = _this.keypath.join(newIndex);

      fragment.index = newIndex;

      // notify any registered index refs directly
      if (deps = fragment.registeredIndexRefs) {
        deps.forEach(shuffle__blindRebind);
      }

      fragment.rebind(oldKeypath, newKeypath);
      reboundFragments[newIndex] = fragment;
    });

    newLength = this.root.viewmodel.get(this.keypath).length;

    // If nothing changed with the existing fragments, then we start adding
    // new fragments at the end...
    if (firstChange === undefined) {
      // ...unless there are no new fragments to add
      if (this.length === newLength) {
        return;
      }

      firstChange = this.length;
    }

    this.length = this.fragments.length = newLength;

    if (this.rendered) {
      runloop.addView(this);
    }

    // Prepare new fragment options
    fragmentOptions = {
      template: this.template.f,
      root: this.root,
      owner: this
    };

    // Add as many new fragments as we need to, or add back existing
    // (detached) fragments
    for (i = firstChange; i < newLength; i += 1) {
      fragment = reboundFragments[i];

      if (!fragment) {
        this.fragmentsToCreate.push(i);
      }

      this.fragments[i] = fragment;
    }
  }

  function shuffle__blindRebind(dep) {
    // the keypath doesn't actually matter here as it won't have changed
    dep.rebind("", "");
  }
  //# sourceMappingURL=02-6to5-shuffle.js.map

  var prototype_rebind = function (oldKeypath, newKeypath) {
    Mustache.rebind.call(this, oldKeypath, newKeypath);
  };
  //# sourceMappingURL=02-6to5-rebind.js.map

  function Section$render() {
    var _this = this;
    this.docFrag = document.createDocumentFragment();

    this.fragments.forEach(function (f) {
      return _this.docFrag.appendChild(f.render());
    });

    this.renderedFragments = this.fragments.slice();
    this.fragmentsToRender = [];

    this.rendered = true;
    return this.docFrag;
  }
  //# sourceMappingURL=02-6to5-render.js.map

  function Section$setValue(value) {
    var _this = this;
    var wrapper, fragmentOptions;

    if (this.updating) {
      // If a child of this section causes a re-evaluation - for example, an
      // expression refers to a function that mutates the array that this
      // section depends on - we'll end up with a double rendering bug (see
      // https://github.com/ractivejs/ractive/issues/748). This prevents it.
      return;
    }

    this.updating = true;

    // with sections, we need to get the fake value if we have a wrapped object
    if (this.keypath && (wrapper = this.root.viewmodel.wrapped[this.keypath.str])) {
      value = wrapper.get();
    }

    // If any fragments are awaiting creation after a splice,
    // this is the place to do it
    if (this.fragmentsToCreate.length) {
      fragmentOptions = {
        template: this.template.f,
        root: this.root,
        pElement: this.pElement,
        owner: this
      };

      this.fragmentsToCreate.forEach(function (index) {
        var fragment;

        fragmentOptions.context = _this.keypath.join(index);
        fragmentOptions.index = index;

        fragment = new Fragment(fragmentOptions);
        _this.fragmentsToRender.push(_this.fragments[index] = fragment);
      });

      this.fragmentsToCreate.length = 0;
    } else if (reevaluateSection(this, value)) {
      this.bubble();

      if (this.rendered) {
        runloop.addView(this);
      }
    }

    this.value = value;
    this.updating = false;
  }

  function changeCurrentSubtype(section, value, obj) {
    if (value === SECTION_EACH) {
      // make sure ref type is up to date for key or value indices
      if (section.indexRefs && section.indexRefs[0]) {
        var ref = section.indexRefs[0];

        // when switching flavors, make sure the section gets updated
        if (obj && ref.t === "i" || !obj && ref.t === "k") {
          // if switching from object to list, unbind all of the old fragments
          if (!obj) {
            section.length = 0;
            section.fragmentsToUnrender = section.fragments.slice(0);
            section.fragmentsToUnrender.forEach(function (f) {
              return f.unbind();
            });
          }
        }

        ref.t = obj ? "k" : "i";
      }
    }

    section.currentSubtype = value;
  }

  function reevaluateSection(section, value) {
    var fragmentOptions = {
      template: section.template.f,
      root: section.root,
      pElement: section.parentFragment.pElement,
      owner: section
    };

    // If we already know the section type, great
    // TODO can this be optimised? i.e. pick an reevaluateSection function during init
    // and avoid doing this each time?
    if (section.subtype) {
      switch (section.subtype) {
        case SECTION_IF:
          return reevaluateConditionalSection(section, value, false, fragmentOptions);

        case SECTION_UNLESS:
          return reevaluateConditionalSection(section, value, true, fragmentOptions);

        case SECTION_WITH:
          return reevaluateContextSection(section, fragmentOptions);

        case SECTION_IF_WITH:
          return reevaluateConditionalContextSection(section, value, fragmentOptions);

        case SECTION_EACH:
          if (isObject(value)) {
            changeCurrentSubtype(section, section.subtype, true);
            return reevaluateListObjectSection(section, value, fragmentOptions);
          }

          // Fallthrough - if it's a conditional or an array we need to continue
      }
    }

    // Otherwise we need to work out what sort of section we're dealing with
    section.ordered = !!isArrayLike(value);

    // Ordered list section
    if (section.ordered) {
      changeCurrentSubtype(section, SECTION_EACH, false);
      return reevaluateListSection(section, value, fragmentOptions);
    }

    // Unordered list, or context
    if (isObject(value) || typeof value === "function") {
      // Index reference indicates section should be treated as a list
      if (section.template.i) {
        changeCurrentSubtype(section, SECTION_EACH, true);
        return reevaluateListObjectSection(section, value, fragmentOptions);
      }

      // Otherwise, object provides context for contents
      changeCurrentSubtype(section, SECTION_WITH, false);
      return reevaluateContextSection(section, fragmentOptions);
    }

    // Conditional section
    changeCurrentSubtype(section, SECTION_IF, false);
    return reevaluateConditionalSection(section, value, false, fragmentOptions);
  }

  function reevaluateListSection(section, value, fragmentOptions) {
    var i, length, fragment;

    length = value.length;

    if (length === section.length) {
      // Nothing to do
      return false;
    }

    // if the array is shorter than it was previously, remove items
    if (length < section.length) {
      section.fragmentsToUnrender = section.fragments.splice(length, section.length - length);
      section.fragmentsToUnrender.forEach(methodCallers__unbind);
    }

    // otherwise...
    else {
      if (length > section.length) {
        // add any new ones
        for (i = section.length; i < length; i += 1) {
          // append list item to context stack
          fragmentOptions.context = section.keypath.join(i);
          fragmentOptions.index = i;

          fragment = new Fragment(fragmentOptions);
          section.fragmentsToRender.push(section.fragments[i] = fragment);
        }
      }
    }

    section.length = length;
    return true;
  }

  function reevaluateListObjectSection(section, value, fragmentOptions) {
    var id, i, hasKey, fragment, changed, deps;

    hasKey = section.hasKey || (section.hasKey = {});

    // remove any fragments that should no longer exist
    i = section.fragments.length;
    while (i--) {
      fragment = section.fragments[i];

      if (!(fragment.key in value)) {
        changed = true;

        fragment.unbind();
        section.fragmentsToUnrender.push(fragment);
        section.fragments.splice(i, 1);

        hasKey[fragment.key] = false;
      }
    }

    // notify any dependents about changed indices
    i = section.fragments.length;
    while (i--) {
      fragment = section.fragments[i];

      if (fragment.index !== i) {
        fragment.index = i;
        if (deps = fragment.registeredIndexRefs) {
          deps.forEach(setValue__blindRebind);
        }
      }
    }

    // add any that haven't been created yet
    i = section.fragments.length;
    for (id in value) {
      if (!hasKey[id]) {
        changed = true;

        fragmentOptions.context = section.keypath.join(id);
        fragmentOptions.key = id;
        fragmentOptions.index = i++;

        fragment = new Fragment(fragmentOptions);

        section.fragmentsToRender.push(fragment);
        section.fragments.push(fragment);
        hasKey[id] = true;
      }
    }

    section.length = section.fragments.length;
    return changed;
  }

  function reevaluateConditionalContextSection(section, value, fragmentOptions) {
    if (value) {
      return reevaluateContextSection(section, fragmentOptions);
    } else {
      return removeSectionFragments(section);
    }
  }

  function reevaluateContextSection(section, fragmentOptions) {
    var fragment;

    // ...then if it isn't rendered, render it, adding section.keypath to the context stack
    // (if it is already rendered, then any children dependent on the context stack
    // will update themselves without any prompting)
    if (!section.length) {
      // append this section to the context stack
      fragmentOptions.context = section.keypath;
      fragmentOptions.index = 0;

      fragment = new Fragment(fragmentOptions);

      section.fragmentsToRender.push(section.fragments[0] = fragment);
      section.length = 1;

      return true;
    }
  }

  function reevaluateConditionalSection(section, value, inverted, fragmentOptions) {
    var doRender, emptyArray, emptyObject, fragment, name;

    emptyArray = isArrayLike(value) && value.length === 0;
    emptyObject = false;
    if (!isArrayLike(value) && isObject(value)) {
      emptyObject = true;
      for (name in value) {
        emptyObject = false;
        break;
      }
    }

    if (inverted) {
      doRender = emptyArray || emptyObject || !value;
    } else {
      doRender = value && !emptyArray && !emptyObject;
    }

    if (doRender) {
      if (!section.length) {
        // no change to context stack
        fragmentOptions.index = 0;

        fragment = new Fragment(fragmentOptions);
        section.fragmentsToRender.push(section.fragments[0] = fragment);
        section.length = 1;

        return true;
      }

      if (section.length > 1) {
        section.fragmentsToUnrender = section.fragments.splice(1);
        section.fragmentsToUnrender.forEach(methodCallers__unbind);

        return true;
      }
    } else {
      return removeSectionFragments(section);
    }
  }

  function removeSectionFragments(section) {
    if (section.length) {
      section.fragmentsToUnrender = section.fragments.splice(0, section.fragments.length).filter(isRendered);
      section.fragmentsToUnrender.forEach(methodCallers__unbind);
      section.length = section.fragmentsToRender.length = 0;
      return true;
    }
  }

  function isRendered(fragment) {
    return fragment.rendered;
  }

  function setValue__blindRebind(dep) {
    // the keypath doesn't actually matter here as it won't have changed
    dep.rebind("", "");
  }
  //# sourceMappingURL=02-6to5-setValue.js.map

  function Section$toString(escape) {
    var str, i, len;

    str = "";

    i = 0;
    len = this.length;

    for (i = 0; i < len; i += 1) {
      str += this.fragments[i].toString(escape);
    }

    return str;
  }
  //# sourceMappingURL=02-6to5-toString.js.map

  function Section$unbind() {
    var _this = this;
    this.fragments.forEach(methodCallers__unbind);
    this.fragmentsToRender.forEach(function (f) {
      return removeFromArray(_this.fragments, f);
    });
    this.fragmentsToRender = [];
    unbind__unbind.call(this);

    this.length = 0;
    this.unbound = true;
  }
  //# sourceMappingURL=02-6to5-unbind.js.map

  function Section$unrender(shouldDestroy) {
    this.fragments.forEach(shouldDestroy ? unrenderAndDestroy : unrender__unrender);
    this.renderedFragments = [];
    this.rendered = false;
  }

  function unrenderAndDestroy(fragment) {
    fragment.unrender(true);
  }

  function unrender__unrender(fragment) {
    fragment.unrender(false);
  }
  //# sourceMappingURL=02-6to5-unrender.js.map

  function Section$update() {
    var fragment, renderIndex, renderedFragments, anchor, target, i, len;

    // `this.renderedFragments` is in the order of the previous render.
    // If fragments have shuffled about, this allows us to quickly
    // reinsert them in the correct place
    renderedFragments = this.renderedFragments;

    // Remove fragments that have been marked for destruction
    while (fragment = this.fragmentsToUnrender.pop()) {
      fragment.unrender(true);
      renderedFragments.splice(renderedFragments.indexOf(fragment), 1);
    }

    // Render new fragments (but don't insert them yet)
    while (fragment = this.fragmentsToRender.shift()) {
      fragment.render();
    }

    if (this.rendered) {
      target = this.parentFragment.getNode();
    }

    len = this.fragments.length;
    for (i = 0; i < len; i += 1) {
      fragment = this.fragments[i];
      renderIndex = renderedFragments.indexOf(fragment, i); // search from current index - it's guaranteed to be the same or higher

      if (renderIndex === i) {
        // already in the right place. insert accumulated nodes (if any) and carry on
        if (this.docFrag.childNodes.length) {
          anchor = fragment.firstNode();
          target.insertBefore(this.docFrag, anchor);
        }

        continue;
      }

      this.docFrag.appendChild(fragment.detach());

      // update renderedFragments
      if (renderIndex !== -1) {
        renderedFragments.splice(renderIndex, 1);
      }
      renderedFragments.splice(i, 0, fragment);
    }

    if (this.rendered && this.docFrag.childNodes.length) {
      anchor = this.parentFragment.findNextNode(this);
      target.insertBefore(this.docFrag, anchor);
    }

    // Save the rendering order for next time
    this.renderedFragments = this.fragments.slice();
  }
  //# sourceMappingURL=02-6to5-update.js.map

  var Section = function (options) {
    this.type = SECTION;
    this.subtype = this.currentSubtype = options.template.n;
    this.inverted = this.subtype === SECTION_UNLESS;


    this.pElement = options.pElement;

    this.fragments = [];
    this.fragmentsToCreate = [];
    this.fragmentsToRender = [];
    this.fragmentsToUnrender = [];

    if (options.template.i) {
      this.indexRefs = options.template.i.split(",").map(function (k, i) {
        return { n: k, t: i === 0 ? "k" : "i" };
      });
    }

    this.renderedFragments = [];

    this.length = 0; // number of times this section is rendered

    Mustache.init(this, options);
  };

  Section.prototype = {
    bubble: Section$bubble,
    detach: Section$detach,
    find: Section$find,
    findAll: Section$findAll,
    findAllComponents: Section$findAllComponents,
    findComponent: Section$findComponent,
    findNextNode: Section$findNextNode,
    firstNode: Section$firstNode,
    getIndexRef: function (name) {
      if (this.indexRefs) {
        var i = this.indexRefs.length;
        while (i--) {
          var ref = this.indexRefs[i];
          if (ref.n === name) {
            return ref;
          }
        }
      }
    },
    getValue: Mustache.getValue,
    shuffle: Section$shuffle,
    rebind: prototype_rebind,
    render: Section$render,
    resolve: Mustache.resolve,
    setValue: Section$setValue,
    toString: Section$toString,
    unbind: Section$unbind,
    unrender: Section$unrender,
    update: Section$update
  };


  //# sourceMappingURL=02-6to5-_Section.js.map

  function Triple$detach() {
    var len, i;

    if (this.docFrag) {
      len = this.nodes.length;
      for (i = 0; i < len; i += 1) {
        this.docFrag.appendChild(this.nodes[i]);
      }

      return this.docFrag;
    }
  }
  //# sourceMappingURL=02-6to5-detach.js.map

  function Triple$find(selector) {
    var i, len, node, queryResult;

    len = this.nodes.length;
    for (i = 0; i < len; i += 1) {
      node = this.nodes[i];

      if (node.nodeType !== 1) {
        continue;
      }

      if (matches(node, selector)) {
        return node;
      }

      if (queryResult = node.querySelector(selector)) {
        return queryResult;
      }
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-find.js.map

  function Triple$findAll(selector, queryResult) {
    var i, len, node, queryAllResult, numNodes, j;

    len = this.nodes.length;
    for (i = 0; i < len; i += 1) {
      node = this.nodes[i];

      if (node.nodeType !== 1) {
        continue;
      }

      if (matches(node, selector)) {
        queryResult.push(node);
      }

      if (queryAllResult = node.querySelectorAll(selector)) {
        numNodes = queryAllResult.length;
        for (j = 0; j < numNodes; j += 1) {
          queryResult.push(queryAllResult[j]);
        }
      }
    }
  }
  //# sourceMappingURL=02-6to5-findAll.js.map

  function Triple$firstNode() {
    if (this.rendered && this.nodes[0]) {
      return this.nodes[0];
    }

    return this.parentFragment.findNextNode(this);
  }
  //# sourceMappingURL=02-6to5-firstNode.js.map

  var elementCache = {},
      ieBug,
      ieBlacklist;

  try {
    createElement("table").innerHTML = "foo";
  } catch (err) {
    ieBug = true;

    ieBlacklist = {
      TABLE: ["<table class=\"x\">", "</table>"],
      THEAD: ["<table><thead class=\"x\">", "</thead></table>"],
      TBODY: ["<table><tbody class=\"x\">", "</tbody></table>"],
      TR: ["<table><tr class=\"x\">", "</tr></table>"],
      SELECT: ["<select class=\"x\">", "</select>"]
    };
  }

  var insertHtml = function (html, node, docFrag) {
    var container,
        nodes = [],
        wrapper,
        selectedOption,
        child,
        i;

    // render 0 and false
    if (html != null && html !== "") {
      if (ieBug && (wrapper = ieBlacklist[node.tagName])) {
        container = element("DIV");
        container.innerHTML = wrapper[0] + html + wrapper[1];
        container = container.querySelector(".x");

        if (container.tagName === "SELECT") {
          selectedOption = container.options[container.selectedIndex];
        }
      } else if (node.namespaceURI === namespaces.svg) {
        container = element("DIV");
        container.innerHTML = "<svg class=\"x\">" + html + "</svg>";
        container = container.querySelector(".x");
      } else {
        container = element(node.tagName);
        container.innerHTML = html;

        if (container.tagName === "SELECT") {
          selectedOption = container.options[container.selectedIndex];
        }
      }

      while (child = container.firstChild) {
        nodes.push(child);
        docFrag.appendChild(child);
      }

      // This is really annoying. Extracting <option> nodes from the
      // temporary container <select> causes the remaining ones to
      // become selected. So now we have to deselect them. IE8, you
      // amaze me. You really do
      // ...and now Chrome too
      if (node.tagName === "SELECT") {
        i = nodes.length;
        while (i--) {
          if (nodes[i] !== selectedOption) {
            nodes[i].selected = false;
          }
        }
      }
    }

    return nodes;
  };

  function element(tagName) {
    return elementCache[tagName] || (elementCache[tagName] = createElement(tagName));
  }
  //# sourceMappingURL=02-6to5-insertHtml.js.map

  function updateSelect(parentElement) {
    var selectedOptions, option, value;

    if (!parentElement || parentElement.name !== "select" || !parentElement.binding) {
      return;
    }

    selectedOptions = toArray(parentElement.node.options).filter(isSelected);

    // If one of them had a `selected` attribute, we need to sync
    // the model to the view
    if (parentElement.getAttribute("multiple")) {
      value = selectedOptions.map(function (o) {
        return o.value;
      });
    } else if (option = selectedOptions[0]) {
      value = option.value;
    }

    if (value !== undefined) {
      parentElement.binding.setValue(value);
    }

    parentElement.bubble();
  }

  function isSelected(option) {
    return option.selected;
  }
  //# sourceMappingURL=02-6to5-updateSelect.js.map

  function Triple$render() {
    if (this.rendered) {
      throw new Error("Attempted to render an item that was already rendered");
    }

    this.docFrag = document.createDocumentFragment();
    this.nodes = insertHtml(this.value, this.parentFragment.getNode(), this.docFrag);

    // Special case - we're inserting the contents of a <select>
    updateSelect(this.pElement);

    this.rendered = true;
    return this.docFrag;
  }
  //# sourceMappingURL=02-6to5-render.js.map

  function Triple$setValue(value) {
    var wrapper;

    // TODO is there a better way to approach this?
    if (wrapper = this.root.viewmodel.wrapped[this.keypath.str]) {
      value = wrapper.get();
    }

    if (value !== this.value) {
      this.value = value;
      this.parentFragment.bubble();

      if (this.rendered) {
        runloop.addView(this);
      }
    }
  }
  //# sourceMappingURL=02-6to5-setValue.js.map

  function Triple$toString() {
    return this.value != undefined ? decodeCharacterReferences("" + this.value) : "";
  }
  //# sourceMappingURL=02-6to5-toString.js.map

  function Triple$unrender(shouldDestroy) {
    if (this.rendered && shouldDestroy) {
      this.nodes.forEach(detachNode);
      this.rendered = false;
    }

    // TODO update live queries
  }
  //# sourceMappingURL=02-6to5-unrender.js.map

  function Triple$update() {
    var node, parentNode;

    if (!this.rendered) {
      return;
    }

    // Remove existing nodes
    while (this.nodes && this.nodes.length) {
      node = this.nodes.pop();
      node.parentNode.removeChild(node);
    }

    // Insert new nodes
    parentNode = this.parentFragment.getNode();

    this.nodes = insertHtml(this.value, parentNode, this.docFrag);
    parentNode.insertBefore(this.docFrag, this.parentFragment.findNextNode(this));

    // Special case - we're inserting the contents of a <select>
    updateSelect(this.pElement);
  }
  //# sourceMappingURL=02-6to5-update.js.map

  var Triple = function (options) {
    this.type = TRIPLE;
    Mustache.init(this, options);
  };

  Triple.prototype = {
    detach: Triple$detach,
    find: Triple$find,
    findAll: Triple$findAll,
    firstNode: Triple$firstNode,
    getValue: Mustache.getValue,
    rebind: Mustache.rebind,
    render: Triple$render,
    resolve: Mustache.resolve,
    setValue: Triple$setValue,
    toString: Triple$toString,
    unbind: unbind__unbind,
    unrender: Triple$unrender,
    update: Triple$update
  };


  //# sourceMappingURL=02-6to5-_Triple.js.map

  var Element_prototype_bubble = function () {
    this.parentFragment.bubble();
  };
  //# sourceMappingURL=02-6to5-bubble.js.map

  function Element$detach() {
    var node = this.node,
        parentNode;

    if (node) {
      // need to check for parent node - DOM may have been altered
      // by something other than Ractive! e.g. jQuery UI...
      if (parentNode = node.parentNode) {
        parentNode.removeChild(node);
      }

      return node;
    }
  }
  //# sourceMappingURL=02-6to5-detach.js.map

  var Element_prototype_find = function (selector) {
    if (!this.node) {
      // this element hasn't been rendered yet
      return null;
    }

    if (matches(this.node, selector)) {
      return this.node;
    }

    if (this.fragment && this.fragment.find) {
      return this.fragment.find(selector);
    }
  };
  //# sourceMappingURL=02-6to5-find.js.map

  var Element_prototype_findAll = function (selector, query) {
    // Add this node to the query, if applicable, and register the
    // query on this element
    if (query._test(this, true) && query.live) {
      (this.liveQueries || (this.liveQueries = [])).push(query);
    }

    if (this.fragment) {
      this.fragment.findAll(selector, query);
    }
  };
  //# sourceMappingURL=02-6to5-findAll.js.map

  var Element_prototype_findAllComponents = function (selector, query) {
    if (this.fragment) {
      this.fragment.findAllComponents(selector, query);
    }
  };
  //# sourceMappingURL=02-6to5-findAllComponents.js.map

  var Element_prototype_findComponent = function (selector) {
    if (this.fragment) {
      return this.fragment.findComponent(selector);
    }
  };
  //# sourceMappingURL=02-6to5-findComponent.js.map

  function Element$findNextNode() {
    return null;
  }
  //# sourceMappingURL=02-6to5-findNextNode.js.map

  function Element$firstNode() {
    return this.node;
  }
  //# sourceMappingURL=02-6to5-firstNode.js.map

  function Element$getAttribute(name) {
    if (!this.attributes || !this.attributes[name]) {
      return;
    }

    return this.attributes[name].value;
  }
  //# sourceMappingURL=02-6to5-getAttribute.js.map

  var truthy = /^true|on|yes|1$/i;
  var processBindingAttributes__isNumeric = /^[0-9]+$/;

  var processBindingAttributes = function (element, template) {
    var val, attrs, attributes;

    attributes = template.a || {};
    attrs = {};

    // attributes that are present but don't have a value (=)
    // will be set to the number 0, which we condider to be true
    // the string '0', however is false

    val = attributes.twoway;
    if (val !== undefined) {
      attrs.twoway = val === 0 || truthy.test(val);
    }

    val = attributes.lazy;
    if (val !== undefined) {
      // check for timeout value
      if (val !== 0 && processBindingAttributes__isNumeric.test(val)) {
        attrs.lazy = parseInt(val);
      } else {
        attrs.lazy = val === 0 || truthy.test(val);
      }
    }

    return attrs;
  };
  //# sourceMappingURL=02-6to5-processBindingAttributes.js.map

  function Attribute$bubble() {
    var value = this.useProperty || !this.rendered ? this.fragment.getValue() : this.fragment.toString();

    // TODO this can register the attribute multiple times (see render test
    // 'Attribute with nested mustaches')
    if (!isEqual(value, this.value)) {
      // Need to clear old id from ractive.nodes
      if (this.name === "id" && this.value) {
        delete this.root.nodes[this.value];
      }

      this.value = value;

      if (this.name === "value" && this.node) {
        // We need to store the value on the DOM like this so we
        // can retrieve it later without it being coerced to a string
        this.node._ractive.value = value;
      }

      if (this.rendered) {
        runloop.addView(this);
      }
    }
  }
  //# sourceMappingURL=02-6to5-bubble.js.map

  var svgCamelCaseElements, svgCamelCaseAttributes, createMap, enforceCase__map;
  svgCamelCaseElements = "altGlyph altGlyphDef altGlyphItem animateColor animateMotion animateTransform clipPath feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence foreignObject glyphRef linearGradient radialGradient textPath vkern".split(" ");
  svgCamelCaseAttributes = "attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits contentScriptType contentStyleType diffuseConstant edgeMode externalResourcesRequired filterRes filterUnits glyphRef gradientTransform gradientUnits kernelMatrix kernelUnitLength keyPoints keySplines keyTimes lengthAdjust limitingConeAngle markerHeight markerUnits markerWidth maskContentUnits maskUnits numOctaves pathLength patternContentUnits patternTransform patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio primitiveUnits refX refY repeatCount repeatDur requiredExtensions requiredFeatures specularConstant specularExponent spreadMethod startOffset stdDeviation stitchTiles surfaceScale systemLanguage tableValues targetX targetY textLength viewBox viewTarget xChannelSelector yChannelSelector zoomAndPan".split(" ");

  createMap = function (items) {
    var map = {},
        i = items.length;
    while (i--) {
      map[items[i].toLowerCase()] = items[i];
    }
    return map;
  };

  enforceCase__map = createMap(svgCamelCaseElements.concat(svgCamelCaseAttributes));

  var enforceCase = function (elementName) {
    var lowerCaseElementName = elementName.toLowerCase();
    return enforceCase__map[lowerCaseElementName] || lowerCaseElementName;
  };
  //# sourceMappingURL=02-6to5-enforceCase.js.map

  var determineNameAndNamespace = function (attribute, name) {
    var colonIndex, namespacePrefix;

    // are we dealing with a namespaced attribute, e.g. xlink:href?
    colonIndex = name.indexOf(":");
    if (colonIndex !== -1) {
      // looks like we are, yes...
      namespacePrefix = name.substr(0, colonIndex);

      // ...unless it's a namespace *declaration*, which we ignore (on the assumption
      // that only valid namespaces will be used)
      if (namespacePrefix !== "xmlns") {
        name = name.substring(colonIndex + 1);

        attribute.name = enforceCase(name);
        attribute.namespace = namespaces[namespacePrefix.toLowerCase()];
        attribute.namespacePrefix = namespacePrefix;

        if (!attribute.namespace) {
          throw "Unknown namespace (\"" + namespacePrefix + "\")";
        }

        return;
      }
    }

    // SVG attribute names are case sensitive
    attribute.name = attribute.element.namespace !== namespaces.html ? enforceCase(name) : name;
  };
  //# sourceMappingURL=02-6to5-determineNameAndNamespace.js.map

  function getInterpolator(attribute) {
    var items = attribute.fragment.items;

    if (items.length !== 1) {
      return;
    }

    if (items[0].type === INTERPOLATOR) {
      return items[0];
    }
  }
  //# sourceMappingURL=02-6to5-getInterpolator.js.map

  function Attribute$init(options) {
    this.type = ATTRIBUTE;
    this.element = options.element;
    this.root = options.root;

    determineNameAndNamespace(this, options.name);
    this.isBoolean = booleanAttributes.test(this.name);

    // if it's an empty attribute, or just a straight key-value pair, with no
    // mustache shenanigans, set the attribute accordingly and go home
    if (!options.value || typeof options.value === "string") {
      this.value = this.isBoolean ? true : options.value || "";
      return;
    }

    // otherwise we need to do some work

    // share parentFragment with parent element
    this.parentFragment = this.element.parentFragment;

    this.fragment = new Fragment({
      template: options.value,
      root: this.root,
      owner: this
    });

    // TODO can we use this.fragment.toString() in some cases? It's quicker
    this.value = this.fragment.getValue();

    // Store a reference to this attribute's interpolator, if its fragment
    // takes the form `{{foo}}`. This is necessary for two-way binding and
    // for correctly rendering HTML later
    this.interpolator = getInterpolator(this);
    this.isBindable = !!this.interpolator && !this.interpolator.isStatic;

    // mark as ready
    this.ready = true;
  }
  //# sourceMappingURL=02-6to5-init.js.map

  function Attribute$rebind(oldKeypath, newKeypath) {
    if (this.fragment) {
      this.fragment.rebind(oldKeypath, newKeypath);
    }
  }
  //# sourceMappingURL=02-6to5-rebind.js.map

  var propertyNames = {
    "accept-charset": "acceptCharset",
    accesskey: "accessKey",
    bgcolor: "bgColor",
    "class": "className",
    codebase: "codeBase",
    colspan: "colSpan",
    contenteditable: "contentEditable",
    datetime: "dateTime",
    dirname: "dirName",
    "for": "htmlFor",
    "http-equiv": "httpEquiv",
    ismap: "isMap",
    maxlength: "maxLength",
    novalidate: "noValidate",
    pubdate: "pubDate",
    readonly: "readOnly",
    rowspan: "rowSpan",
    tabindex: "tabIndex",
    usemap: "useMap"
  };

  function Attribute$render(node) {
    var propertyName;

    this.node = node;

    // should we use direct property access, or setAttribute?
    if (!node.namespaceURI || node.namespaceURI === namespaces.html) {
      propertyName = propertyNames[this.name] || this.name;

      if (node[propertyName] !== undefined) {
        this.propertyName = propertyName;
      }

      // is attribute a boolean attribute or 'value'? If so we're better off doing e.g.
      // node.selected = true rather than node.setAttribute( 'selected', '' )
      if (this.isBoolean || this.isTwoway) {
        this.useProperty = true;
      }

      if (propertyName === "value") {
        node._ractive.value = this.value;
      }
    }

    this.rendered = true;
    this.update();
  }
  //# sourceMappingURL=02-6to5-render.js.map

  function Attribute$toString() {
    var _ref = this;
    var name = _ref.name;
    var namespacePrefix = _ref.namespacePrefix;
    var value = _ref.value;
    var interpolator = _ref.interpolator;
    var fragment = _ref.fragment;


    // Special case - select and textarea values (should not be stringified)
    if (name === "value" && (this.element.name === "select" || this.element.name === "textarea")) {
      return;
    }

    // Special case - content editable
    if (name === "value" && this.element.getAttribute("contenteditable") !== undefined) {
      return;
    }

    // Special case - radio names
    if (name === "name" && this.element.name === "input" && interpolator) {
      return "name={{" + (interpolator.keypath.str || interpolator.ref) + "}}";
    }

    // Boolean attributes
    if (this.isBoolean) {
      return value ? name : "";
    }

    if (fragment) {
      value = fragment.toString();
    }

    if (namespacePrefix) {
      name = namespacePrefix + ":" + name;
    }

    return value ? name + "=\"" + Attribute_prototype_toString__escape(value) + "\"" : name;
  }

  function Attribute_prototype_toString__escape(value) {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  //# sourceMappingURL=02-6to5-toString.js.map

  function Attribute$unbind() {
    // ignore non-dynamic attributes
    if (this.fragment) {
      this.fragment.unbind();
    }

    if (this.name === "id") {
      delete this.root.nodes[this.value];
    }
  }
  //# sourceMappingURL=02-6to5-unbind.js.map

  function Attribute$updateSelect() {
    var value = this.value,
        options,
        option,
        optionValue,
        i;

    if (!this.locked) {
      this.node._ractive.value = value;

      options = this.node.options;
      i = options.length;

      while (i--) {
        option = options[i];
        optionValue = option._ractive ? option._ractive.value : option.value; // options inserted via a triple don't have _ractive

        if (optionValue == value) {
          // double equals as we may be comparing numbers with strings
          option.selected = true;
          break;
        }
      }
    }

    // if we're still here, it means the new value didn't match any of the options...
    // TODO figure out what to do in this situation
  }
  //# sourceMappingURL=02-6to5-updateSelectValue.js.map

  function Attribute$updateMultipleSelect() {
    var value = this.value,
        options,
        i,
        option,
        optionValue;

    if (!isArray(value)) {
      value = [value];
    }

    options = this.node.options;
    i = options.length;

    while (i--) {
      option = options[i];
      optionValue = option._ractive ? option._ractive.value : option.value; // options inserted via a triple don't have _ractive
      option.selected = arrayContains(value, optionValue);
    }
  }
  //# sourceMappingURL=02-6to5-updateMultipleSelectValue.js.map

  function Attribute$updateRadioName() {
    var _ref = this;
    var node = _ref.node;
    var value = _ref.value;
    node.checked = value == node._ractive.value;
  }
  //# sourceMappingURL=02-6to5-updateRadioName.js.map

  function Attribute$updateRadioValue() {
    var wasChecked,
        node = this.node,
        binding,
        bindings,
        i;

    wasChecked = node.checked;

    node.value = this.element.getAttribute("value");
    node.checked = this.element.getAttribute("value") === this.element.getAttribute("name");

    // This is a special case - if the input was checked, and the value
    // changed so that it's no longer checked, the twoway binding is
    // most likely out of date. To fix it we have to jump through some
    // hoops... this is a little kludgy but it works
    if (wasChecked && !node.checked && this.element.binding) {
      bindings = this.element.binding.siblings;

      if (i = bindings.length) {
        while (i--) {
          binding = bindings[i];

          if (!binding.element.node) {
            // this is the initial render, siblings are still rendering!
            // we'll come back later...
            return;
          }

          if (binding.element.node.checked) {
            runloop.addViewmodel(binding.root.viewmodel);
            return binding.handleChange();
          }
        }

        this.root.viewmodel.set(binding.keypath, undefined);
      }
    }
  }
  //# sourceMappingURL=02-6to5-updateRadioValue.js.map

  function Attribute$updateCheckboxName() {
    var _ref = this;
    var element = _ref.element;
    var node = _ref.node;
    var value = _ref.value;var binding = element.binding;var valueAttribute;var i;

    valueAttribute = element.getAttribute("value");

    if (!isArray(value)) {
      binding.isChecked = node.checked = value == valueAttribute;
    } else {
      i = value.length;
      while (i--) {
        if (valueAttribute == value[i]) {
          binding.isChecked = node.checked = true;
          return;
        }
      }
      binding.isChecked = node.checked = false;
    }
  }
  //# sourceMappingURL=02-6to5-updateCheckboxName.js.map

  function Attribute$updateClassName() {
    var node, value;

    node = this.node;
    value = this.value;

    if (value === undefined) {
      value = "";
    }

    node.className = value;
  }
  //# sourceMappingURL=02-6to5-updateClassName.js.map

  function Attribute$updateIdAttribute() {
    var _ref = this;
    var node = _ref.node;
    var value = _ref.value;


    this.root.nodes[value] = node;
    node.id = value;
  }
  //# sourceMappingURL=02-6to5-updateIdAttribute.js.map

  function Attribute$updateIEStyleAttribute() {
    var node, value;

    node = this.node;
    value = this.value;

    if (value === undefined) {
      value = "";
    }

    node.style.setAttribute("cssText", value);
  }
  //# sourceMappingURL=02-6to5-updateIEStyleAttribute.js.map

  function Attribute$updateContentEditableValue() {
    var value = this.value;

    if (value === undefined) {
      value = "";
    }

    if (!this.locked) {
      this.node.innerHTML = value;
    }
  }
  //# sourceMappingURL=02-6to5-updateContentEditableValue.js.map

  function Attribute$updateValue() {
    var _ref = this;
    var node = _ref.node;
    var value = _ref.value;


    // store actual value, so it doesn't get coerced to a string
    node._ractive.value = value;

    // with two-way binding, only update if the change wasn't initiated by the user
    // otherwise the cursor will often be sent to the wrong place
    if (!this.locked) {
      node.value = value == undefined ? "" : value;
    }
  }
  //# sourceMappingURL=02-6to5-updateValue.js.map

  function Attribute$updateBooleanAttribute() {
    // with two-way binding, only update if the change wasn't initiated by the user
    // otherwise the cursor will often be sent to the wrong place
    if (!this.locked) {
      this.node[this.propertyName] = this.value;
    }
  }
  //# sourceMappingURL=02-6to5-updateBoolean.js.map

  function Attribute$updateEverythingElse() {
    var _ref = this;
    var node = _ref.node;
    var namespace = _ref.namespace;
    var name = _ref.name;
    var value = _ref.value;
    var fragment = _ref.fragment;


    if (namespace) {
      node.setAttributeNS(namespace, name, (fragment || value).toString());
    } else if (!this.isBoolean) {
      node.setAttribute(name, (fragment || value).toString());
    }

    // Boolean attributes - truthy becomes '', falsy means 'remove attribute'
    else {
      if (value) {
        node.setAttribute(name, "");
      } else {
        node.removeAttribute(name);
      }
    }
  }
  //# sourceMappingURL=02-6to5-updateEverythingElse.js.map

  function Attribute$update() {
    var _ref = this;
    var name = _ref.name;
    var element = _ref.element;
    var node = _ref.node;var type;var updateMethod;

    if (name === "id") {
      updateMethod = Attribute$updateIdAttribute;
    } else if (name === "value") {
      // special case - selects
      if (element.name === "select" && name === "value") {
        updateMethod = element.getAttribute("multiple") ? Attribute$updateMultipleSelect : Attribute$updateSelect;
      } else if (element.name === "textarea") {
        updateMethod = Attribute$updateValue;
      }

      // special case - contenteditable
      else if (element.getAttribute("contenteditable") != null) {
        updateMethod = Attribute$updateContentEditableValue;
      }

      // special case - <input>
      else if (element.name === "input") {
        type = element.getAttribute("type");

        // type='file' value='{{fileList}}'>
        if (type === "file") {
          updateMethod = noop; // read-only
        }

        // type='radio' name='{{twoway}}'
        else if (type === "radio" && element.binding && element.binding.name === "name") {
          updateMethod = Attribute$updateRadioValue;
        } else {
          updateMethod = Attribute$updateValue;
        }
      }
    }

    // special case - <input type='radio' name='{{twoway}}' value='foo'>
    else if (this.isTwoway && name === "name") {
      if (node.type === "radio") {
        updateMethod = Attribute$updateRadioName;
      } else if (node.type === "checkbox") {
        updateMethod = Attribute$updateCheckboxName;
      }
    }

    // special case - style attributes in Internet Exploder
    else if (name === "style" && node.style.setAttribute) {
      updateMethod = Attribute$updateIEStyleAttribute;
    }

    // special case - class names. IE fucks things up, again
    else if (name === "class" && (!node.namespaceURI || node.namespaceURI === namespaces.html)) {
      updateMethod = Attribute$updateClassName;
    } else if (this.useProperty) {
      updateMethod = Attribute$updateBooleanAttribute;
    }

    if (!updateMethod) {
      updateMethod = Attribute$updateEverythingElse;
    }

    this.update = updateMethod;
    this.update();
  }
  //# sourceMappingURL=02-6to5-update.js.map

  var Attribute = function (options) {
    this.init(options);
  };

  Attribute.prototype = {
    bubble: Attribute$bubble,
    init: Attribute$init,
    rebind: Attribute$rebind,
    render: Attribute$render,
    toString: Attribute$toString,
    unbind: Attribute$unbind,
    update: Attribute$update
  };


  //# sourceMappingURL=02-6to5-_Attribute.js.map

  var createAttributes = function (element, attributes) {
    var name,
        attribute,
        result = [];

    for (name in attributes) {
      // skip binding attributes
      if (name === "twoway" || name === "lazy") {
        continue;
      }

      if (attributes.hasOwnProperty(name)) {
        attribute = new Attribute({
          element: element,
          name: name,
          value: attributes[name],
          root: element.root
        });

        result[name] = attribute;

        if (name !== "value") {
          result.push(attribute);
        }
      }
    }

    // value attribute goes last. This is because it
    // may get clamped on render otherwise, e.g. in
    // `<input type='range' value='999' min='0' max='1000'>`
    // since default max is 100
    if (attribute = result.value) {
      result.push(attribute);
    }

    return result;
  };
  //# sourceMappingURL=02-6to5-createAttributes.js.map

  var ConditionalAttribute__div;

  if (typeof document !== "undefined") {
    ConditionalAttribute__div = createElement("div");
  }

  var ConditionalAttribute = function (element, template) {
    this.element = element;
    this.root = element.root;
    this.parentFragment = element.parentFragment;

    this.attributes = [];

    this.fragment = new Fragment({
      root: element.root,
      owner: this,
      template: [template]
    });
  };

  ConditionalAttribute.prototype = {
    bubble: function () {
      if (this.node) {
        this.update();
      }

      this.element.bubble();
    },

    rebind: function (oldKeypath, newKeypath) {
      this.fragment.rebind(oldKeypath, newKeypath);
    },

    render: function (node) {
      this.node = node;
      this.isSvg = node.namespaceURI === namespaces.svg;

      this.update();
    },

    unbind: function () {
      this.fragment.unbind();
    },

    update: function () {
      var _this = this;
      var str, attrs;

      str = this.fragment.toString();
      attrs = parseAttributes(str, this.isSvg);

      // any attributes that previously existed but no longer do
      // must be removed
      this.attributes.filter(function (a) {
        return notIn(attrs, a);
      }).forEach(function (a) {
        _this.node.removeAttribute(a.name);
      });

      attrs.forEach(function (a) {
        _this.node.setAttribute(a.name, a.value);
      });

      this.attributes = attrs;
    },

    toString: function () {
      return this.fragment.toString();
    }
  };




  function parseAttributes(str, isSvg) {
    var tag = isSvg ? "svg" : "div";
    ConditionalAttribute__div.innerHTML = "<" + tag + " " + str + "></" + tag + ">";

    return toArray(ConditionalAttribute__div.childNodes[0].attributes);
  }

  function notIn(haystack, needle) {
    var i = haystack.length;

    while (i--) {
      if (haystack[i].name === needle.name) {
        return false;
      }
    }

    return true;
  }
  //# sourceMappingURL=02-6to5-_ConditionalAttribute.js.map

  var createConditionalAttributes = function (element, attributes) {
    if (!attributes) {
      return [];
    }

    return attributes.map(function (a) {
      return new ConditionalAttribute(element, a);
    });
  };
  //# sourceMappingURL=02-6to5-createConditionalAttributes.js.map

  var Binding = function (element) {
    var interpolator, keypath, value, parentForm;

    this.element = element;
    this.root = element.root;
    this.attribute = element.attributes[this.name || "value"];

    interpolator = this.attribute.interpolator;
    interpolator.twowayBinding = this;

    if (keypath = interpolator.keypath) {
      if (keypath.str.slice(-1) === "}") {
        warn("Two-way binding does not work with expressions (`%s` on <%s>)", interpolator.resolver.uniqueString, element.name);
        return false;
      }
    } else {
      // A mustache may be *ambiguous*. Let's say we were given
      // `value="{{bar}}"`. If the context was `foo`, and `foo.bar`
      // *wasn't* `undefined`, the keypath would be `foo.bar`.
      // Then, any user input would result in `foo.bar` being updated.
      //
      // If, however, `foo.bar` *was* undefined, and so was `bar`, we would be
      // left with an unresolved partial keypath - so we are forced to make an
      // assumption. That assumption is that the input in question should
      // be forced to resolve to `bar`, and any user input would affect `bar`
      // and not `foo.bar`.
      //
      // Did that make any sense? No? Oh. Sorry. Well the moral of the story is
      // be explicit when using two-way data-binding about what keypath you're
      // updating. Using it in lists is probably a recipe for confusion...
      interpolator.resolver.forceResolution();
      keypath = interpolator.keypath;
    }

    this.attribute.isTwoway = true;
    this.keypath = keypath;

    // initialise value, if it's undefined
    value = this.root.viewmodel.get(keypath);

    if (value === undefined && this.getInitialValue) {
      value = this.getInitialValue();

      if (value !== undefined) {
        this.root.viewmodel.set(keypath, value);
      }
    }

    if (parentForm = findParentForm(element)) {
      this.resetValue = value;
      parentForm.formBindings.push(this);
    }
  };

  Binding.prototype = {
    handleChange: function () {
      var _this = this;
      runloop.start(this.root);
      this.attribute.locked = true;
      this.root.viewmodel.set(this.keypath, this.getValue());
      runloop.scheduleTask(function () {
        return _this.attribute.locked = false;
      });
      runloop.end();
    },

    rebound: function () {
      var bindings, oldKeypath, newKeypath;

      oldKeypath = this.keypath;
      newKeypath = this.attribute.interpolator.keypath;

      // The attribute this binding is linked to has already done the work
      if (oldKeypath === newKeypath) {
        return;
      }

      removeFromArray(this.root._twowayBindings[oldKeypath.str], this);

      this.keypath = newKeypath;

      bindings = this.root._twowayBindings[newKeypath.str] || (this.root._twowayBindings[newKeypath.str] = []);
      bindings.push(this);
    },

    unbind: function () {}
  };

  Binding.extend = function (properties) {
    var Parent = this,
        SpecialisedBinding;

    SpecialisedBinding = function (element) {
      Binding.call(this, element);

      if (this.init) {
        this.init();
      }
    };

    SpecialisedBinding.prototype = create(Parent.prototype);
    object__extend(SpecialisedBinding.prototype, properties);

    SpecialisedBinding.extend = Binding.extend;

    return SpecialisedBinding;
  };

  var Binding__default = Binding;

  function findParentForm(element) {
    while (element = element.parent) {
      if (element.name === "form") {
        return element;
      }
    }
  }
  // this is called when the element is unbound.
  // Specialised bindings can override it
  //# sourceMappingURL=02-6to5-Binding.js.map

  // This is the handler for DOM events that would lead to a change in the model
  // (i.e. change, sometimes, input, and occasionally click and keyup)
  function handleChange() {
    this._ractive.binding.handleChange();
  }
  //# sourceMappingURL=02-6to5-handleDomEvent.js.map

  var ContentEditableBinding = Binding__default.extend({
    getInitialValue: function () {
      return this.element.fragment ? this.element.fragment.toString() : "";
    },

    render: function () {
      var node = this.element.node;

      node.addEventListener("change", handleChange, false);

      if (!this.root.lazy) {
        node.addEventListener("input", handleChange, false);

        if (node.attachEvent) {
          node.addEventListener("keyup", handleChange, false);
        }
      }
    },

    unrender: function () {
      var node = this.element.node;

      node.removeEventListener("change", handleChange, false);
      node.removeEventListener("input", handleChange, false);
      node.removeEventListener("keyup", handleChange, false);
    },

    getValue: function () {
      return this.element.node.innerHTML;
    }
  });


  //# sourceMappingURL=02-6to5-ContentEditableBinding.js.map

  var sets = {};

  function getSiblings(id, group, keypath) {
    var hash = id + group + keypath;
    return sets[hash] || (sets[hash] = []);
  }
  //# sourceMappingURL=02-6to5-getSiblings.js.map

  var RadioBinding = Binding__default.extend({
    name: "checked",

    init: function () {
      this.siblings = getSiblings(this.root._guid, "radio", this.element.getAttribute("name"));
      this.siblings.push(this);
    },

    render: function () {
      var node = this.element.node;

      node.addEventListener("change", handleChange, false);

      if (node.attachEvent) {
        node.addEventListener("click", handleChange, false);
      }
    },

    unrender: function () {
      var node = this.element.node;

      node.removeEventListener("change", handleChange, false);
      node.removeEventListener("click", handleChange, false);
    },

    handleChange: function () {
      runloop.start(this.root);

      this.siblings.forEach(function (binding) {
        binding.root.viewmodel.set(binding.keypath, binding.getValue());
      });

      runloop.end();
    },

    getValue: function () {
      return this.element.node.checked;
    },

    unbind: function () {
      removeFromArray(this.siblings, this);
    }
  });


  //# sourceMappingURL=02-6to5-RadioBinding.js.map

  var RadioNameBinding = Binding__default.extend({
    name: "name",

    init: function () {
      this.siblings = getSiblings(this.root._guid, "radioname", this.keypath.str);
      this.siblings.push(this);

      this.radioName = true; // so that ractive.updateModel() knows what to do with this
    },

    getInitialValue: function () {
      if (this.element.getAttribute("checked")) {
        return this.element.getAttribute("value");
      }
    },

    render: function () {
      var node = this.element.node;

      node.name = "{{" + this.keypath.str + "}}";
      node.checked = this.root.viewmodel.get(this.keypath) == this.element.getAttribute("value");

      node.addEventListener("change", handleChange, false);

      if (node.attachEvent) {
        node.addEventListener("click", handleChange, false);
      }
    },

    unrender: function () {
      var node = this.element.node;

      node.removeEventListener("change", handleChange, false);
      node.removeEventListener("click", handleChange, false);
    },

    getValue: function () {
      var node = this.element.node;
      return node._ractive ? node._ractive.value : node.value;
    },

    handleChange: function () {
      // If this <input> is the one that's checked, then the value of its
      // `name` keypath gets set to its value
      if (this.element.node.checked) {
        Binding__default.prototype.handleChange.call(this);
      }
    },

    rebound: function (oldKeypath, newKeypath) {
      var node;

      Binding__default.prototype.rebound.call(this, oldKeypath, newKeypath);

      if (node = this.element.node) {
        node.name = "{{" + this.keypath.str + "}}";
      }
    },

    unbind: function () {
      removeFromArray(this.siblings, this);
    }
  });


  //# sourceMappingURL=02-6to5-RadioNameBinding.js.map

  var CheckboxNameBinding = Binding__default.extend({
    name: "name",

    getInitialValue: function () {
      // This only gets called once per group (of inputs that
      // share a name), because it only gets called if there
      // isn't an initial value. By the same token, we can make
      // a note of that fact that there was no initial value,
      // and populate it using any `checked` attributes that
      // exist (which users should avoid, but which we should
      // support anyway to avoid breaking expectations)
      this.noInitialValue = true;
      return [];
    },

    init: function () {
      var existingValue, bindingValue;

      this.checkboxName = true; // so that ractive.updateModel() knows what to do with this

      // Each input has a reference to an array containing it and its
      // siblings, as two-way binding depends on being able to ascertain
      // the status of all inputs within the group
      this.siblings = getSiblings(this.root._guid, "checkboxes", this.keypath.str);
      this.siblings.push(this);

      if (this.noInitialValue) {
        this.siblings.noInitialValue = true;
      }

      // If no initial value was set, and this input is checked, we
      // update the model
      if (this.siblings.noInitialValue && this.element.getAttribute("checked")) {
        existingValue = this.root.viewmodel.get(this.keypath);
        bindingValue = this.element.getAttribute("value");

        existingValue.push(bindingValue);
      }
    },

    unbind: function () {
      removeFromArray(this.siblings, this);
    },

    render: function () {
      var node = this.element.node,
          existingValue,
          bindingValue;

      existingValue = this.root.viewmodel.get(this.keypath);
      bindingValue = this.element.getAttribute("value");

      if (isArray(existingValue)) {
        this.isChecked = arrayContains(existingValue, bindingValue);
      } else {
        this.isChecked = existingValue == bindingValue;
      }

      node.name = "{{" + this.keypath.str + "}}";
      node.checked = this.isChecked;

      node.addEventListener("change", handleChange, false);

      // in case of IE emergency, bind to click event as well
      if (node.attachEvent) {
        node.addEventListener("click", handleChange, false);
      }
    },

    unrender: function () {
      var node = this.element.node;

      node.removeEventListener("change", handleChange, false);
      node.removeEventListener("click", handleChange, false);
    },

    changed: function () {
      var wasChecked = !!this.isChecked;
      this.isChecked = this.element.node.checked;
      return this.isChecked === wasChecked;
    },

    handleChange: function () {
      this.isChecked = this.element.node.checked;
      Binding__default.prototype.handleChange.call(this);
    },

    getValue: function () {
      return this.siblings.filter(isChecked).map(CheckboxNameBinding__getValue);
    }
  });

  function isChecked(binding) {
    return binding.isChecked;
  }

  function CheckboxNameBinding__getValue(binding) {
    return binding.element.getAttribute("value");
  }


  //# sourceMappingURL=02-6to5-CheckboxNameBinding.js.map

  var CheckboxBinding = Binding__default.extend({
    name: "checked",

    render: function () {
      var node = this.element.node;

      node.addEventListener("change", handleChange, false);

      if (node.attachEvent) {
        node.addEventListener("click", handleChange, false);
      }
    },

    unrender: function () {
      var node = this.element.node;

      node.removeEventListener("change", handleChange, false);
      node.removeEventListener("click", handleChange, false);
    },

    getValue: function () {
      return this.element.node.checked;
    }
  });


  //# sourceMappingURL=02-6to5-CheckboxBinding.js.map

  var SelectBinding = Binding__default.extend({
    getInitialValue: function () {
      var options = this.element.options,
          len,
          i,
          value,
          optionWasSelected;

      if (this.element.getAttribute("value") !== undefined) {
        return;
      }

      i = len = options.length;

      if (!len) {
        return;
      }

      // take the final selected option...
      while (i--) {
        if (options[i].getAttribute("selected")) {
          value = options[i].getAttribute("value");
          optionWasSelected = true;
          break;
        }
      }

      // or the first non-disabled option, if none are selected
      if (!optionWasSelected) {
        while (++i < len) {
          if (!options[i].getAttribute("disabled")) {
            value = options[i].getAttribute("value");
            break;
          }
        }
      }

      // This is an optimisation (aka hack) that allows us to forgo some
      // other more expensive work
      if (value !== undefined) {
        this.element.attributes.value.value = value;
      }

      return value;
    },

    render: function () {
      this.element.node.addEventListener("change", handleChange, false);
    },

    unrender: function () {
      this.element.node.removeEventListener("change", handleChange, false);
    },

    // TODO this method is an anomaly... is it necessary?
    setValue: function (value) {
      this.root.viewmodel.set(this.keypath, value);
    },

    getValue: function () {
      var options, i, len, option, optionValue;

      options = this.element.node.options;
      len = options.length;

      for (i = 0; i < len; i += 1) {
        option = options[i];

        if (options[i].selected) {
          optionValue = option._ractive ? option._ractive.value : option.value;
          return optionValue;
        }
      }
    },

    forceUpdate: function () {
      var _this = this;
      var value = this.getValue();

      if (value !== undefined) {
        this.attribute.locked = true;
        runloop.scheduleTask(function () {
          return _this.attribute.locked = false;
        });
        this.root.viewmodel.set(this.keypath, value);
      }
    }
  });


  //# sourceMappingURL=02-6to5-SelectBinding.js.map

  var MultipleSelectBinding = SelectBinding.extend({
    getInitialValue: function () {
      return this.element.options.filter(function (option) {
        return option.getAttribute("selected");
      }).map(function (option) {
        return option.getAttribute("value");
      });
    },

    render: function () {
      var valueFromModel;

      this.element.node.addEventListener("change", handleChange, false);

      valueFromModel = this.root.viewmodel.get(this.keypath);

      if (valueFromModel === undefined) {
        // get value from DOM, if possible
        this.handleChange();
      }
    },

    unrender: function () {
      this.element.node.removeEventListener("change", handleChange, false);
    },

    setValue: function () {
      throw new Error("TODO not implemented yet");
    },

    getValue: function () {
      var selectedValues, options, i, len, option, optionValue;

      selectedValues = [];
      options = this.element.node.options;
      len = options.length;

      for (i = 0; i < len; i += 1) {
        option = options[i];

        if (option.selected) {
          optionValue = option._ractive ? option._ractive.value : option.value;
          selectedValues.push(optionValue);
        }
      }

      return selectedValues;
    },

    handleChange: function () {
      var attribute, previousValue, value;

      attribute = this.attribute;
      previousValue = attribute.value;

      value = this.getValue();

      if (previousValue === undefined || !arrayContentsMatch(value, previousValue)) {
        SelectBinding.prototype.handleChange.call(this);
      }

      return this;
    },

    forceUpdate: function () {
      var _this = this;
      var value = this.getValue();

      if (value !== undefined) {
        this.attribute.locked = true;
        runloop.scheduleTask(function () {
          return _this.attribute.locked = false;
        });
        this.root.viewmodel.set(this.keypath, value);
      }
    },

    updateModel: function () {
      if (this.attribute.value === undefined || !this.attribute.value.length) {
        this.root.viewmodel.set(this.keypath, this.initialValue);
      }
    }
  });


  //# sourceMappingURL=02-6to5-MultipleSelectBinding.js.map

  var FileListBinding = Binding__default.extend({
    render: function () {
      this.element.node.addEventListener("change", handleChange, false);
    },

    unrender: function () {
      this.element.node.removeEventListener("change", handleChange, false);
    },

    getValue: function () {
      return this.element.node.files;
    }
  });


  //# sourceMappingURL=02-6to5-FileListBinding.js.map

  var GenericBinding;

  GenericBinding = Binding__default.extend({
    getInitialValue: function () {
      return "";
    },

    getValue: function () {
      return this.element.node.value;
    },

    render: function () {
      var node = this.element.node,
          lazy,
          timeout = false;
      this.rendered = true;

      // any lazy setting for this element overrides the root
      // if the value is a number, it's a timeout
      lazy = this.root.lazy;
      if (this.element.lazy === true) {
        lazy = true;
      } else if (this.element.lazy === false) {
        lazy = false;
      } else if (is__isNumeric(this.element.lazy)) {
        lazy = false;
        timeout = +this.element.lazy;
      } else if (is__isNumeric(lazy || "")) {
        timeout = +lazy;
        lazy = false;

        // make sure the timeout is available to the handler
        this.element.lazy = timeout;
      }

      this.handler = timeout ? handleDelay : handleChange;

      node.addEventListener("change", handleChange, false);

      if (!lazy) {
        node.addEventListener("input", this.handler, false);

        if (node.attachEvent) {
          node.addEventListener("keyup", this.handler, false);
        }
      }

      node.addEventListener("blur", handleBlur, false);
    },

    unrender: function () {
      var node = this.element.node;
      this.rendered = false;

      node.removeEventListener("change", handleChange, false);
      node.removeEventListener("input", this.handler, false);
      node.removeEventListener("keyup", this.handler, false);
      node.removeEventListener("blur", handleBlur, false);
    }
  });




  function handleBlur() {
    var value;

    handleChange.call(this);

    value = this._ractive.root.viewmodel.get(this._ractive.binding.keypath);
    this.value = value == undefined ? "" : value;
  }

  function handleDelay() {
    var binding = this._ractive.binding,
        el = this;

    if (!!binding._timeout) clearTimeout(binding._timeout);

    binding._timeout = setTimeout(function () {
      if (binding.rendered) handleChange.call(el);
      binding._timeout = undefined;
    }, binding.element.lazy);
  }
  //# sourceMappingURL=02-6to5-GenericBinding.js.map

  var NumericBinding = GenericBinding.extend({
    getInitialValue: function () {
      return undefined;
    },

    getValue: function () {
      var value = parseFloat(this.element.node.value);
      return isNaN(value) ? undefined : value;
    }
  });
  //# sourceMappingURL=02-6to5-NumericBinding.js.map

  function createTwowayBinding(element) {
    var attributes = element.attributes,
        type,
        Binding,
        bindName,
        bindChecked,
        binding;

    // if this is a late binding, and there's already one, it
    // needs to be torn down
    if (element.binding) {
      element.binding.teardown();
      element.binding = null;
    }

    // contenteditable
    if (
    // if the contenteditable attribute is true or is bindable and may thus become true
    (element.getAttribute("contenteditable") || !!attributes.contenteditable && isBindable(attributes.contenteditable)) && isBindable(attributes.value)) {
      Binding = ContentEditableBinding;
    }

    // <input>
    else if (element.name === "input") {
      type = element.getAttribute("type");

      if (type === "radio" || type === "checkbox") {
        bindName = isBindable(attributes.name);
        bindChecked = isBindable(attributes.checked);

        // we can either bind the name attribute, or the checked attribute - not both
        if (bindName && bindChecked) {
          warn("A radio input can have two-way binding on its name attribute, or its checked attribute - not both");
        }

        if (bindName) {
          Binding = type === "radio" ? RadioNameBinding : CheckboxNameBinding;
        } else if (bindChecked) {
          Binding = type === "radio" ? RadioBinding : CheckboxBinding;
        }
      } else if (type === "file" && isBindable(attributes.value)) {
        Binding = FileListBinding;
      } else if (isBindable(attributes.value)) {
        Binding = type === "number" || type === "range" ? NumericBinding : GenericBinding;
      }
    }

    // <select>
    else if (element.name === "select" && isBindable(attributes.value)) {
      Binding = element.getAttribute("multiple") ? MultipleSelectBinding : SelectBinding;
    }

    // <textarea>
    else if (element.name === "textarea" && isBindable(attributes.value)) {
      Binding = GenericBinding;
    }

    if (Binding && (binding = new Binding(element)) && binding.keypath) {
      return binding;
    }
  }

  function isBindable(attribute) {
    return attribute && attribute.isBindable;
  }
  // and this element also has a value attribute to bind
  //# sourceMappingURL=02-6to5-createTwowayBinding.js.map

  function EventHandler$bubble() {
    var hasAction = this.getAction();

    if (hasAction && !this.hasListener) {
      this.listen();
    } else if (!hasAction && this.hasListener) {
      this.unrender();
    }
  }
  //# sourceMappingURL=02-6to5-bubble.js.map

  function EventHandler$fire(event) {
    fireEvent(this.root, this.getAction(), { event: event });
  }
  //# sourceMappingURL=02-6to5-fire.js.map

  function EventHandler$getAction() {
    return this.action.toString().trim();
  }
  //# sourceMappingURL=02-6to5-getAction.js.map

  var eventPattern = /^event(?:\.(.+))?/;

  function EventHandler$init(element, name, template) {
    var _this = this;
    var action, refs, ractive;

    this.element = element;
    this.root = element.root;
    this.parentFragment = element.parentFragment;
    this.name = name;

    if (name.indexOf("*") !== -1) {
      (this.root.debug ? fatal : warn)("Only component proxy-events may contain \"*\" wildcards, <%s on-%s=\"...\"/> is not valid", element.name, name);
      this.invalid = true;
    }

    if (template.m) {
      refs = template.a.r;

      // This is a method call
      this.method = template.m;
      this.keypaths = [];
      this.fn = getFunctionFromString(template.a.s, refs.length);

      this.parentFragment = element.parentFragment;
      ractive = this.root;

      // Create resolvers for each reference
      this.refResolvers = [];
      refs.forEach(function (ref, i) {
        var match = undefined;

        // special case - the `event` object
        if (match = eventPattern.exec(ref)) {
          _this.keypaths[i] = {
            eventObject: true,
            refinements: match[1] ? match[1].split(".") : []
          };
        } else {
          _this.refResolvers.push(createReferenceResolver(_this, ref, function (keypath) {
            return _this.resolve(i, keypath);
          }));
        }
      });

      this.fire = fireMethodCall;
    } else {
      // Get action ('foo' in 'on-click='foo')
      action = template.n || template;
      if (typeof action !== "string") {
        action = new Fragment({
          template: action,
          root: this.root,
          owner: this
        });
      }

      this.action = action;

      // Get parameters
      if (template.d) {
        this.dynamicParams = new Fragment({
          template: template.d,
          root: this.root,
          owner: this.element
        });

        this.fire = fireEventWithDynamicParams;
      } else if (template.a) {
        this.params = template.a;
        this.fire = fireEventWithParams;
      }
    }
  }


  function fireMethodCall(event) {
    var ractive, values, args;

    ractive = this.root;

    if (typeof ractive[this.method] !== "function") {
      throw new Error("Attempted to call a non-existent method (\"" + this.method + "\")");
    }

    values = this.keypaths.map(function (keypath) {
      var value, len, i;

      if (keypath === undefined) {
        // not yet resolved
        return undefined;
      }

      // TODO the refinements stuff would be better handled at parse time
      if (keypath.eventObject) {
        value = event;

        if (len = keypath.refinements.length) {
          for (i = 0; i < len; i += 1) {
            value = value[keypath.refinements[i]];
          }
        }
      } else {
        value = ractive.viewmodel.get(keypath);
      }

      return value;
    });

    eventStack.enqueue(ractive, event);

    args = this.fn.apply(null, values);
    ractive[this.method].apply(ractive, args);

    eventStack.dequeue(ractive);
  }

  function fireEventWithParams(event) {
    fireEvent(this.root, this.getAction(), { event: event, args: this.params });
  }

  function fireEventWithDynamicParams(event) {
    var args = this.dynamicParams.getArgsList();

    // need to strip [] from ends if a string!
    if (typeof args === "string") {
      args = args.substr(1, args.length - 2);
    }

    fireEvent(this.root, this.getAction(), { event: event, args: args });
  }
  //# sourceMappingURL=02-6to5-init.js.map

  function genericHandler(event) {
    var storage,
        handler,
        indices,
        index = {};

    storage = this._ractive;
    handler = storage.events[event.type];

    if (indices = findIndexRefs(handler.element.parentFragment)) {
      index = findIndexRefs.resolve(indices);
    }

    handler.fire({
      node: this,
      original: event,
      index: index,
      keypath: storage.keypath.str,
      context: storage.root.viewmodel.get(storage.keypath)
    });
  }
  //# sourceMappingURL=02-6to5-genericHandler.js.map

  var customHandlers = {},
      touchEvents = {
    touchstart: true,
    touchmove: true,
    touchend: true,
    touchcancel: true,
    //not w3c, but supported in some browsers
    touchleave: true
  };

  function EventHandler$listen() {
    var definition,
        name = this.name;

    if (this.invalid) {
      return;
    }

    if (definition = findInViewHierarchy("events", this.root, name)) {
      this.custom = definition(this.node, getCustomHandler(name));
    } else {
      // Looks like we're dealing with a standard DOM event... but let's check
      if (!("on" + name in this.node) && !(window && "on" + name in window)) {
        // okay to use touch events if this browser doesn't support them
        if (!touchEvents[name]) {
          warnOnce(missingPlugin(name, "event"));
        }

        return;
      }

      this.node.addEventListener(name, genericHandler, false);
    }

    this.hasListener = true;
  }

  function getCustomHandler(name) {
    if (!customHandlers[name]) {
      customHandlers[name] = function (event) {
        var storage = event.node._ractive;

        event.index = storage.index;
        event.keypath = storage.keypath.str;
        event.context = storage.root.viewmodel.get(storage.keypath);

        storage.events[name].fire(event);
      };
    }

    return customHandlers[name];
  }
  //# sourceMappingURL=02-6to5-listen.js.map

  function EventHandler$rebind(oldKeypath, newKeypath) {
    var rebind = function (thing) {
      thing && thing.rebind(oldKeypath, newKeypath);
    };

    var fragment;
    if (this.method) {
      fragment = this.element.parentFragment;
      this.refResolvers.forEach(rebind);

      return;
    }

    if (typeof this.action !== "string") {
      rebind(this.action);
    }

    if (this.dynamicParams) {
      rebind(this.dynamicParams);
    }
  }
  //# sourceMappingURL=02-6to5-rebind.js.map

  function EventHandler$render() {
    this.node = this.element.node;
    // store this on the node itself, so it can be retrieved by a
    // universal handler
    this.node._ractive.events[this.name] = this;

    if (this.method || this.getAction()) {
      this.listen();
    }
  }
  //# sourceMappingURL=02-6to5-render.js.map

  function EventHandler$resolve(index, keypath) {
    this.keypaths[index] = keypath;
  }
  //# sourceMappingURL=02-6to5-resolve.js.map

  function EventHandler$unbind() {
    if (this.method) {
      this.refResolvers.forEach(methodCallers__unbind);
      return;
    }

    // Tear down dynamic name
    if (typeof this.action !== "string") {
      this.action.unbind();
    }

    // Tear down dynamic parameters
    if (this.dynamicParams) {
      this.dynamicParams.unbind();
    }
  }
  //# sourceMappingURL=02-6to5-unbind.js.map

  function EventHandler$unrender() {
    if (this.custom) {
      this.custom.teardown();
    } else {
      this.node.removeEventListener(this.name, genericHandler, false);
    }

    this.hasListener = false;
  }
  //# sourceMappingURL=02-6to5-unrender.js.map

  var EventHandler = function (element, name, template) {
    this.init(element, name, template);
  };

  EventHandler.prototype = {
    bubble: EventHandler$bubble,
    fire: EventHandler$fire,
    getAction: EventHandler$getAction,
    init: EventHandler$init,
    listen: EventHandler$listen,
    rebind: EventHandler$rebind,
    render: EventHandler$render,
    resolve: EventHandler$resolve,
    unbind: EventHandler$unbind,
    unrender: EventHandler$unrender
  };


  //# sourceMappingURL=02-6to5-_EventHandler.js.map

  var createEventHandlers = function (element, template) {
    var i,
        name,
        names,
        handler,
        result = [];

    for (name in template) {
      if (template.hasOwnProperty(name)) {
        names = name.split("-");
        i = names.length;

        while (i--) {
          handler = new EventHandler(element, names[i], template[name]);
          result.push(handler);
        }
      }
    }

    return result;
  };
  //# sourceMappingURL=02-6to5-createEventHandlers.js.map

  var Decorator = function (element, template) {
    var self = this,
        ractive,
        name,
        fragment;

    this.element = element;
    this.root = ractive = element.root;

    name = template.n || template;

    if (typeof name !== "string") {
      fragment = new Fragment({
        template: name,
        root: ractive,
        owner: element
      });

      name = fragment.toString();
      fragment.unbind();

      if (name === "") {
        // empty string okay, just no decorator
        return;
      }
    }

    if (template.a) {
      this.params = template.a;
    } else if (template.d) {
      this.fragment = new Fragment({
        template: template.d,
        root: ractive,
        owner: element
      });

      this.params = this.fragment.getArgsList();

      this.fragment.bubble = function () {
        this.dirtyArgs = this.dirtyValue = true;
        self.params = this.getArgsList();

        if (self.ready) {
          self.update();
        }
      };
    }

    this.fn = findInViewHierarchy("decorators", ractive, name);

    if (!this.fn) {
      warn(missingPlugin(name, "decorator"));
    }
  };

  Decorator.prototype = {
    init: function () {
      var node, result, args;

      node = this.element.node;

      if (this.params) {
        args = [node].concat(this.params);
        result = this.fn.apply(this.root, args);
      } else {
        result = this.fn.call(this.root, node);
      }

      if (!result || !result.teardown) {
        throw new Error("Decorator definition must return an object with a teardown method");
      }

      // TODO does this make sense?
      this.actual = result;
      this.ready = true;
    },

    update: function () {
      if (this.actual.update) {
        this.actual.update.apply(this.root, this.params);
      } else {
        this.actual.teardown(true);
        this.init();
      }
    },

    rebind: function (oldKeypath, newKeypath) {
      if (this.fragment) {
        this.fragment.rebind(oldKeypath, newKeypath);
      }
    },

    teardown: function (updating) {
      this.torndown = true;
      if (this.ready) {
        this.actual.teardown();
      }

      if (!updating && this.fragment) {
        this.fragment.unbind();
      }
    }
  };


  //# sourceMappingURL=02-6to5-_Decorator.js.map

  function select__bubble() {
    var _this = this;
    if (!this.dirty) {
      this.dirty = true;

      runloop.scheduleTask(function () {
        sync(_this);
        _this.dirty = false;
      });
    }

    this.parentFragment.bubble(); // default behaviour
  }

  function sync(selectElement) {
    var selectNode, selectValue, isMultiple, options, optionWasSelected;

    selectNode = selectElement.node;

    if (!selectNode) {
      return;
    }

    options = toArray(selectNode.options);

    selectValue = selectElement.getAttribute("value");
    isMultiple = selectElement.getAttribute("multiple");

    // If the <select> has a specified value, that should override
    // these options
    if (selectValue !== undefined) {
      options.forEach(function (o) {
        var optionValue, shouldSelect;

        optionValue = o._ractive ? o._ractive.value : o.value;
        shouldSelect = isMultiple ? valueContains(selectValue, optionValue) : selectValue == optionValue;

        if (shouldSelect) {
          optionWasSelected = true;
        }

        o.selected = shouldSelect;
      });

      if (!optionWasSelected) {
        if (options[0]) {
          options[0].selected = true;
        }

        if (selectElement.binding) {
          selectElement.binding.forceUpdate();
        }
      }
    }

    // Otherwise the value should be initialised according to which
    // <option> element is selected, if twoway binding is in effect
    else if (selectElement.binding) {
      selectElement.binding.forceUpdate();
    }
  }

  function valueContains(selectValue, optionValue) {
    var i = selectValue.length;
    while (i--) {
      if (selectValue[i] == optionValue) {
        return true;
      }
    }
  }
  //# sourceMappingURL=02-6to5-select.js.map

  function option__init(option, template) {
    option.select = findParentSelect(option.parent);

    // we might be inside a <datalist> element
    if (!option.select) {
      return;
    }

    option.select.options.push(option);

    // If the value attribute is missing, use the element's content
    if (!template.a) {
      template.a = {};
    }

    // ...as long as it isn't disabled
    if (template.a.value === undefined && !template.a.hasOwnProperty("disabled")) {
      template.a.value = template.f;
    }

    // If there is a `selected` attribute, but the <select>
    // already has a value, delete it
    if ("selected" in template.a && option.select.getAttribute("value") !== undefined) {
      delete template.a.selected;
    }
  }

  function option__unbind(option) {
    if (option.select) {
      removeFromArray(option.select.options, option);
    }
  }

  function findParentSelect(element) {
    if (!element) {
      return;
    }

    do {
      if (element.name === "select") {
        return element;
      }
    } while (element = element.parent);
  }
  //# sourceMappingURL=02-6to5-option.js.map

  function Element$init(options) {
    var parentFragment, template, ractive, binding, bindings, twoway, bindingAttrs;

    this.type = ELEMENT;

    // stuff we'll need later
    parentFragment = this.parentFragment = options.parentFragment;
    template = this.template = options.template;

    this.parent = options.pElement || parentFragment.pElement;

    this.root = ractive = parentFragment.root;
    this.index = options.index;
    this.key = options.key;

    this.name = enforceCase(template.e);

    // Special case - <option> elements
    if (this.name === "option") {
      option__init(this, template);
    }

    // Special case - <select> elements
    if (this.name === "select") {
      this.options = [];
      this.bubble = select__bubble; // TODO this is a kludge
    }

    // Special case - <form> elements
    if (this.name === "form") {
      this.formBindings = [];
    }

    // handle binding attributes first (twoway, lazy)
    bindingAttrs = processBindingAttributes(this, template);

    // create attributes
    this.attributes = createAttributes(this, template.a);
    this.conditionalAttributes = createConditionalAttributes(this, template.m);

    // append children, if there are any
    if (template.f) {
      this.fragment = new Fragment({
        template: template.f,
        root: ractive,
        owner: this,
        pElement: this });
    }

    // the element setting should override the ractive setting
    twoway = ractive.twoway;
    if (bindingAttrs.twoway === false) twoway = false;else if (bindingAttrs.twoway === true) twoway = true;

    this.twoway = twoway;
    this.lazy = bindingAttrs.lazy;

    // create twoway binding
    if (twoway && (binding = createTwowayBinding(this, template.a))) {
      this.binding = binding;

      // register this with the root, so that we can do ractive.updateModel()
      bindings = this.root._twowayBindings[binding.keypath.str] || (this.root._twowayBindings[binding.keypath.str] = []);
      bindings.push(binding);
    }

    // create event proxies
    if (template.v) {
      this.eventHandlers = createEventHandlers(this, template.v);
    }

    // create decorator
    if (template.o) {
      this.decorator = new Decorator(this, template.o);
    }

    // create transitions
    this.intro = template.t0 || template.t1;
    this.outro = template.t0 || template.t2;
  }
  //# sourceMappingURL=02-6to5-init.js.map

  function Element$rebind(oldKeypath, newKeypath) {
    var rebind = function (thing) {
      thing.rebind(oldKeypath, newKeypath);
    };

    var i, storage, liveQueries, ractive;

    if (this.attributes) {
      this.attributes.forEach(rebind);
    }

    if (this.conditionalAttributes) {
      this.conditionalAttributes.forEach(rebind);
    }

    if (this.eventHandlers) {
      this.eventHandlers.forEach(rebind);
    }

    if (this.decorator) {
      rebind(this.decorator);
    }

    // rebind children
    if (this.fragment) {
      rebind(this.fragment);
    }

    // Update live queries, if necessary
    if (liveQueries = this.liveQueries) {
      ractive = this.root;

      i = liveQueries.length;
      while (i--) {
        liveQueries[i]._makeDirty();
      }
    }

    if (this.node && (storage = this.node._ractive)) {
      // adjust keypath if needed
      assignNewKeypath(storage, "keypath", oldKeypath, newKeypath);
    }
  }
  //# sourceMappingURL=02-6to5-rebind.js.map

  function img__render(img) {
    var loadHandler;

    // if this is an <img>, and we're in a crap browser, we may need to prevent it
    // from overriding width and height when it loads the src
    if (img.attributes.width || img.attributes.height) {
      img.node.addEventListener("load", loadHandler = function () {
        var width = img.getAttribute("width"),
            height = img.getAttribute("height");

        if (width !== undefined) {
          img.node.setAttribute("width", width);
        }

        if (height !== undefined) {
          img.node.setAttribute("height", height);
        }

        img.node.removeEventListener("load", loadHandler, false);
      }, false);
    }
  }
  //# sourceMappingURL=02-6to5-img.js.map

  function form__render(element) {
    element.node.addEventListener("reset", handleReset, false);
  }

  function form__unrender(element) {
    element.node.removeEventListener("reset", handleReset, false);
  }

  function handleReset() {
    var element = this._ractive.proxy;

    runloop.start();
    element.formBindings.forEach(updateModel);
    runloop.end();
  }

  function updateModel(binding) {
    binding.root.viewmodel.set(binding.keypath, binding.resetValue);
  }
  //# sourceMappingURL=02-6to5-form.js.map

  function Transition$init(element, template, isIntro) {
    var ractive, name, fragment;

    this.element = element;
    this.root = ractive = element.root;
    this.isIntro = isIntro;

    name = template.n || template;

    if (typeof name !== "string") {
      fragment = new Fragment({
        template: name,
        root: ractive,
        owner: element
      });

      name = fragment.toString();
      fragment.unbind();

      if (name === "") {
        // empty string okay, just no transition
        return;
      }
    }

    this.name = name;

    if (template.a) {
      this.params = template.a;
    } else if (template.d) {
      // TODO is there a way to interpret dynamic arguments without all the
      // 'dependency thrashing'?
      fragment = new Fragment({
        template: template.d,
        root: ractive,
        owner: element
      });

      this.params = fragment.getArgsList();
      fragment.unbind();
    }

    this._fn = findInViewHierarchy("transitions", ractive, name);

    if (!this._fn) {
      warnOnce(missingPlugin(name, "transition"));
    }
  }
  //# sourceMappingURL=02-6to5-init.js.map

  var camelCase = function (hyphenatedStr) {
    return hyphenatedStr.replace(/-([a-zA-Z])/g, function (match, $1) {
      return $1.toUpperCase();
    });
  };
  //# sourceMappingURL=02-6to5-camelCase.js.map

  var prefix__prefix, prefixCache, prefix__testStyle;

  if (!isClient) {
    prefix__prefix = null;
  } else {
    prefixCache = {};
    prefix__testStyle = createElement("div").style;

    prefix__prefix = function (prop) {
      var i, vendor, capped;

      prop = camelCase(prop);

      if (!prefixCache[prop]) {
        if (prefix__testStyle[prop] !== undefined) {
          prefixCache[prop] = prop;
        } else {
          // test vendors...
          capped = prop.charAt(0).toUpperCase() + prop.substring(1);

          i = vendors.length;
          while (i--) {
            vendor = vendors[i];
            if (prefix__testStyle[vendor + capped] !== undefined) {
              prefixCache[prop] = vendor + capped;
              break;
            }
          }
        }
      }

      return prefixCache[prop];
    };
  }

  var prefix__default = prefix__prefix;
  //# sourceMappingURL=02-6to5-prefix.js.map

  var getStyle, getStyle__getComputedStyle;

  if (!isClient) {
    getStyle = null;
  } else {
    getStyle__getComputedStyle = window.getComputedStyle || legacy.getComputedStyle;

    getStyle = function (props) {
      var computedStyle, styles, i, prop, value;

      computedStyle = getStyle__getComputedStyle(this.node);

      if (typeof props === "string") {
        value = computedStyle[prefix__default(props)];
        if (value === "0px") {
          value = 0;
        }
        return value;
      }

      if (!isArray(props)) {
        throw new Error("Transition$getStyle must be passed a string, or an array of strings representing CSS properties");
      }

      styles = {};

      i = props.length;
      while (i--) {
        prop = props[i];
        value = computedStyle[prefix__default(prop)];
        if (value === "0px") {
          value = 0;
        }
        styles[prop] = value;
      }

      return styles;
    };
  }


  //# sourceMappingURL=02-6to5-getStyle.js.map

  var setStyle = function (style, value) {
    var prop;

    if (typeof style === "string") {
      this.node.style[prefix__default(style)] = value;
    } else {
      for (prop in style) {
        if (style.hasOwnProperty(prop)) {
          this.node.style[prefix__default(prop)] = style[prop];
        }
      }
    }

    return this;
  };
  //# sourceMappingURL=02-6to5-setStyle.js.map

  var Ticker = function (options) {
    var easing;

    this.duration = options.duration;
    this.step = options.step;
    this.complete = options.complete;

    // easing
    if (typeof options.easing === "string") {
      easing = options.root.easing[options.easing];

      if (!easing) {
        warnOnce(missingPlugin(options.easing, "easing"));
        easing = linear;
      }
    } else if (typeof options.easing === "function") {
      easing = options.easing;
    } else {
      easing = linear;
    }

    this.easing = easing;

    this.start = getTime();
    this.end = this.start + this.duration;

    this.running = true;
    animations__default.add(this);
  };

  Ticker.prototype = {
    tick: function (now) {
      var elapsed, eased;

      if (!this.running) {
        return false;
      }

      if (now > this.end) {
        if (this.step) {
          this.step(1);
        }

        if (this.complete) {
          this.complete(1);
        }

        return false;
      }

      elapsed = now - this.start;
      eased = this.easing(elapsed / this.duration);

      if (this.step) {
        this.step(eased);
      }

      return true;
    },

    stop: function () {
      if (this.abort) {
        this.abort();
      }

      this.running = false;
    }
  };


  function linear(t) {
    return t;
  }
  //# sourceMappingURL=02-6to5-Ticker.js.map

  var unprefixPattern = new RegExp("^-(?:" + vendors.join("|") + ")-");

  var unprefix = function (prop) {
    return prop.replace(unprefixPattern, "");
  };
  //# sourceMappingURL=02-6to5-unprefix.js.map

  var vendorPattern = new RegExp("^(?:" + vendors.join("|") + ")([A-Z])");

  var hyphenate = function (str) {
    var hyphenated;

    if (!str) {
      return ""; // edge case
    }

    if (vendorPattern.test(str)) {
      str = "-" + str;
    }

    hyphenated = str.replace(/[A-Z]/g, function (match) {
      return "-" + match.toLowerCase();
    });

    return hyphenated;
  };
  //# sourceMappingURL=02-6to5-hyphenate.js.map

  var createTransitions,
      createTransitions__testStyle,
      TRANSITION,
      TRANSITIONEND,
      CSS_TRANSITIONS_ENABLED,
      TRANSITION_DURATION,
      TRANSITION_PROPERTY,
      TRANSITION_TIMING_FUNCTION,
      canUseCssTransitions = {},
      cannotUseCssTransitions = {};

  if (!isClient) {
    createTransitions = null;
  } else {
    createTransitions__testStyle = createElement("div").style;

    // determine some facts about our environment
    (function () {
      if (createTransitions__testStyle.transition !== undefined) {
        TRANSITION = "transition";
        TRANSITIONEND = "transitionend";
        CSS_TRANSITIONS_ENABLED = true;
      } else if (createTransitions__testStyle.webkitTransition !== undefined) {
        TRANSITION = "webkitTransition";
        TRANSITIONEND = "webkitTransitionEnd";
        CSS_TRANSITIONS_ENABLED = true;
      } else {
        CSS_TRANSITIONS_ENABLED = false;
      }
    })();

    if (TRANSITION) {
      TRANSITION_DURATION = TRANSITION + "Duration";
      TRANSITION_PROPERTY = TRANSITION + "Property";
      TRANSITION_TIMING_FUNCTION = TRANSITION + "TimingFunction";
    }

    createTransitions = function (t, to, options, changedProperties, resolve) {
      // Wait a beat (otherwise the target styles will be applied immediately)
      // TODO use a fastdom-style mechanism?
      setTimeout(function () {
        var hashPrefix, jsTransitionsComplete, cssTransitionsComplete, checkComplete, transitionEndHandler;

        checkComplete = function () {
          if (jsTransitionsComplete && cssTransitionsComplete) {
            // will changes to events and fire have an unexpected consequence here?
            t.root.fire(t.name + ":end", t.node, t.isIntro);
            resolve();
          }
        };

        // this is used to keep track of which elements can use CSS to animate
        // which properties
        hashPrefix = (t.node.namespaceURI || "") + t.node.tagName;

        t.node.style[TRANSITION_PROPERTY] = changedProperties.map(prefix__default).map(hyphenate).join(",");
        t.node.style[TRANSITION_TIMING_FUNCTION] = hyphenate(options.easing || "linear");
        t.node.style[TRANSITION_DURATION] = options.duration / 1000 + "s";

        transitionEndHandler = function (event) {
          var index;

          index = changedProperties.indexOf(camelCase(unprefix(event.propertyName)));
          if (index !== -1) {
            changedProperties.splice(index, 1);
          }

          if (changedProperties.length) {
            // still transitioning...
            return;
          }

          t.node.removeEventListener(TRANSITIONEND, transitionEndHandler, false);

          cssTransitionsComplete = true;
          checkComplete();
        };

        t.node.addEventListener(TRANSITIONEND, transitionEndHandler, false);

        setTimeout(function () {
          var i = changedProperties.length,
              hash,
              originalValue,
              index,
              propertiesToTransitionInJs = [],
              prop,
              suffix;

          while (i--) {
            prop = changedProperties[i];
            hash = hashPrefix + prop;

            if (CSS_TRANSITIONS_ENABLED && !cannotUseCssTransitions[hash]) {
              t.node.style[prefix__default(prop)] = to[prop];

              // If we're not sure if CSS transitions are supported for
              // this tag/property combo, find out now
              if (!canUseCssTransitions[hash]) {
                originalValue = t.getStyle(prop);

                // if this property is transitionable in this browser,
                // the current style will be different from the target style
                canUseCssTransitions[hash] = t.getStyle(prop) != to[prop];
                cannotUseCssTransitions[hash] = !canUseCssTransitions[hash];

                // Reset, if we're going to use timers after all
                if (cannotUseCssTransitions[hash]) {
                  t.node.style[prefix__default(prop)] = originalValue;
                }
              }
            }

            if (!CSS_TRANSITIONS_ENABLED || cannotUseCssTransitions[hash]) {
              // we need to fall back to timer-based stuff
              if (originalValue === undefined) {
                originalValue = t.getStyle(prop);
              }

              // need to remove this from changedProperties, otherwise transitionEndHandler
              // will get confused
              index = changedProperties.indexOf(prop);
              if (index === -1) {
                warn("Something very strange happened with transitions. Please raise an issue at https://github.com/ractivejs/ractive/issues - thanks!");
              } else {
                changedProperties.splice(index, 1);
              }

              // TODO Determine whether this property is animatable at all

              suffix = /[^\d]*$/.exec(to[prop])[0];

              // ...then kick off a timer-based transition
              propertiesToTransitionInJs.push({
                name: prefix__default(prop),
                interpolator: interpolate(parseFloat(originalValue), parseFloat(to[prop])),
                suffix: suffix
              });
            }
          }


          // javascript transitions
          if (propertiesToTransitionInJs.length) {
            new Ticker({
              root: t.root,
              duration: options.duration,
              easing: camelCase(options.easing || ""),
              step: function (pos) {
                var prop, i;

                i = propertiesToTransitionInJs.length;
                while (i--) {
                  prop = propertiesToTransitionInJs[i];
                  t.node.style[prop.name] = prop.interpolator(pos) + prop.suffix;
                }
              },
              complete: function () {
                jsTransitionsComplete = true;
                checkComplete();
              }
            });
          } else {
            jsTransitionsComplete = true;
          }


          if (!changedProperties.length) {
            // We need to cancel the transitionEndHandler, and deal with
            // the fact that it will never fire
            t.node.removeEventListener(TRANSITIONEND, transitionEndHandler, false);
            cssTransitionsComplete = true;
            checkComplete();
          }
        }, 0);
      }, options.delay || 0);
    };
  }


  //# sourceMappingURL=02-6to5-createTransitions.js.map

  var hidden, vendor, visibility__prefix, visibility__i, visibility;

  if (typeof document !== "undefined") {
    hidden = "hidden";

    visibility = {};

    if (hidden in document) {
      visibility__prefix = "";
    } else {
      visibility__i = vendors.length;
      while (visibility__i--) {
        vendor = vendors[visibility__i];
        hidden = vendor + "Hidden";

        if (hidden in document) {
          visibility__prefix = vendor;
        }
      }
    }

    if (visibility__prefix !== undefined) {
      document.addEventListener(visibility__prefix + "visibilitychange", onChange);

      // initialise
      onChange();
    } else {
      // gah, we're in an old browser
      if ("onfocusout" in document) {
        document.addEventListener("focusout", onHide);
        document.addEventListener("focusin", onShow);
      } else {
        window.addEventListener("pagehide", onHide);
        window.addEventListener("blur", onHide);

        window.addEventListener("pageshow", onShow);
        window.addEventListener("focus", onShow);
      }

      visibility.hidden = false; // until proven otherwise. Not ideal but hey
    }
  }

  function onChange() {
    visibility.hidden = document[hidden];
  }

  function onHide() {
    visibility.hidden = true;
  }

  function onShow() {
    visibility.hidden = false;
  }


  //# sourceMappingURL=02-6to5-visibility.js.map

  var animateStyle, animateStyle__getComputedStyle, resolved;

  if (!isClient) {
    animateStyle = null;
  } else {
    animateStyle__getComputedStyle = window.getComputedStyle || legacy.getComputedStyle;

    animateStyle = function (style, value, options) {
      var _this = this;
      var to;

      if (arguments.length === 4) {
        throw new Error("t.animateStyle() returns a promise - use .then() instead of passing a callback");
      }

      // Special case - page isn't visible. Don't animate anything, because
      // that way you'll never get CSS transitionend events
      if (visibility.hidden) {
        this.setStyle(style, value);
        return resolved || (resolved = utils_Promise.resolve());
      }

      if (typeof style === "string") {
        to = {};
        to[style] = value;
      } else {
        to = style;

        // shuffle arguments
        options = value;
      }

      // As of 0.3.9, transition authors should supply an `option` object with
      // `duration` and `easing` properties (and optional `delay`), plus a
      // callback function that gets called after the animation completes

      // TODO remove this check in a future version
      if (!options) {
        warn("The \"%s\" transition does not supply an options object to `t.animateStyle()`. This will break in a future version of Ractive. For more info see https://github.com/RactiveJS/Ractive/issues/340", this.name);
        options = this;
      }

      var promise = new utils_Promise(function (resolve) {
        var propertyNames, changedProperties, computedStyle, current, from, i, prop;

        // Edge case - if duration is zero, set style synchronously and complete
        if (!options.duration) {
          _this.setStyle(to);
          resolve();
          return;
        }

        // Get a list of the properties we're animating
        propertyNames = Object.keys(to);
        changedProperties = [];

        // Store the current styles
        computedStyle = animateStyle__getComputedStyle(_this.node);

        from = {};
        i = propertyNames.length;
        while (i--) {
          prop = propertyNames[i];
          current = computedStyle[prefix__default(prop)];

          if (current === "0px") {
            current = 0;
          }

          // we need to know if we're actually changing anything
          if (current != to[prop]) {
            // use != instead of !==, so we can compare strings with numbers
            changedProperties.push(prop);

            // make the computed style explicit, so we can animate where
            // e.g. height='auto'
            _this.node.style[prefix__default(prop)] = current;
          }
        }

        // If we're not actually changing anything, the transitionend event
        // will never fire! So we complete early
        if (!changedProperties.length) {
          resolve();
          return;
        }

        createTransitions(_this, to, options, changedProperties, resolve);
      });

      return promise;
    };
  }


  //# sourceMappingURL=02-6to5-_animateStyle.js.map

  var processParams = function (params, defaults) {
    if (typeof params === "number") {
      params = { duration: params };
    } else if (typeof params === "string") {
      if (params === "slow") {
        params = { duration: 600 };
      } else if (params === "fast") {
        params = { duration: 200 };
      } else {
        params = { duration: 400 };
      }
    } else if (!params) {
      params = {};
    }

    return fillGaps({}, params, defaults);
  };
  //# sourceMappingURL=02-6to5-processParams.js.map

  function Transition$start() {
    var _this = this;
    var node, originalStyle, completed;

    node = this.node = this.element.node;
    originalStyle = node.getAttribute("style");

    // create t.complete() - we don't want this on the prototype,
    // because we don't want `this` silliness when passing it as
    // an argument
    this.complete = function (noReset) {
      if (completed) {
        return;
      }

      if (!noReset && _this.isIntro) {
        resetStyle(node, originalStyle);
      }

      node._ractive.transition = null;
      _this._manager.remove(_this);

      completed = true;
    };

    // If the transition function doesn't exist, abort
    if (!this._fn) {
      this.complete();
      return;
    }

    this._fn.apply(this.root, [this].concat(this.params));
  }

  function resetStyle(node, style) {
    if (style) {
      node.setAttribute("style", style);
    } else {
      // Next line is necessary, to remove empty style attribute!
      // See http://stackoverflow.com/a/7167553
      node.getAttribute("style");
      node.removeAttribute("style");
    }
  }
  //# sourceMappingURL=02-6to5-start.js.map

  var Transition = function (owner, template, isIntro) {
    this.init(owner, template, isIntro);
  };

  Transition.prototype = {
    init: Transition$init,
    start: Transition$start,
    getStyle: getStyle,
    setStyle: setStyle,
    animateStyle: animateStyle,
    processParams: processParams
  };


  //# sourceMappingURL=02-6to5-_Transition.js.map

  var updateCss, updateScript;

  updateCss = function () {
    var node = this.node,
        content = this.fragment.toString(false);

    // IE8 has no styleSheet unless there's a type text/css
    if (window && window.appearsToBeIELessEqual8) {
      node.type = "text/css";
    }

    if (node.styleSheet) {
      node.styleSheet.cssText = content;
    } else {
      while (node.hasChildNodes()) {
        node.removeChild(node.firstChild);
      }

      node.appendChild(document.createTextNode(content));
    }
  };

  updateScript = function () {
    if (!this.node.type || this.node.type === "text/javascript") {
      warn("Script tag was updated. This does not cause the code to be re-evaluated!");
      // As it happens, we ARE in a position to re-evaluate the code if we wanted
      // to - we could eval() it, or insert it into a fresh (temporary) script tag.
      // But this would be a terrible idea with unpredictable results, so let's not.
    }

    this.node.text = this.fragment.toString(false);
  };

  function Element$render() {
    var _this = this;
    var root = this.root,
        namespace,
        node,
        transition;

    namespace = getNamespace(this);
    node = this.node = createElement(this.name, namespace);

    // Is this a top-level node of a component? If so, we may need to add
    // a data-ractive-css attribute, for CSS encapsulation
    // NOTE: css no longer copied to instance, so we check constructor.css -
    // we can enhance to handle instance, but this is more "correct" with current
    // functionality
    if (root.constructor.css && this.parentFragment.getNode() === root.el) {
      this.node.setAttribute("data-ractive-css", root.constructor._guid /*|| root._guid*/);
    }

    // Add _ractive property to the node - we use this object to store stuff
    // related to proxy events, two-way bindings etc
    defineProperty(this.node, "_ractive", {
      value: {
        proxy: this,
        keypath: getInnerContext(this.parentFragment),
        events: create(null),
        root: root
      }
    });

    // Render attributes
    this.attributes.forEach(function (a) {
      return a.render(node);
    });
    this.conditionalAttributes.forEach(function (a) {
      return a.render(node);
    });

    // Render children
    if (this.fragment) {
      // Special case - <script> element
      if (this.name === "script") {
        this.bubble = updateScript;
        this.node.text = this.fragment.toString(false); // bypass warning initially
        this.fragment.unrender = noop; // TODO this is a kludge
      }

      // Special case - <style> element
      else if (this.name === "style") {
        this.bubble = updateCss;
        this.bubble();
        this.fragment.unrender = noop;
      }

      // Special case - contenteditable
      else if (this.binding && this.getAttribute("contenteditable")) {
        this.fragment.unrender = noop;
      } else {
        this.node.appendChild(this.fragment.render());
      }
    }

    // Add proxy event handlers
    if (this.eventHandlers) {
      this.eventHandlers.forEach(function (h) {
        return h.render();
      });
    }

    // deal with two-way bindings
    if (this.binding) {
      this.binding.render();
      this.node._ractive.binding = this.binding;
    }

    if (this.name === "option") {
      processOption(this);
    }

    // Special cases
    if (this.name === "img") {
      // if this is an <img>, and we're in a crap browser, we may
      // need to prevent it from overriding width and height when
      // it loads the src
      img__render(this);
    } else if (this.name === "form") {
      // forms need to keep track of their bindings, in case of reset
      form__render(this);
    } else if (this.name === "input" || this.name === "textarea") {
      // inputs and textareas should store their initial value as
      // `defaultValue` in case of reset
      this.node.defaultValue = this.node.value;
    } else if (this.name === "option") {
      // similarly for option nodes
      this.node.defaultSelected = this.node.selected;
    }

    // apply decorator(s)
    if (this.decorator && this.decorator.fn) {
      runloop.scheduleTask(function () {
        if (!_this.decorator.torndown) {
          _this.decorator.init();
        }
      }, true);
    }

    // trigger intro transition
    if (root.transitionsEnabled && this.intro) {
      transition = new Transition(this, this.intro, true);
      runloop.registerTransition(transition);
      runloop.scheduleTask(function () {
        return transition.start();
      }, true);

      this.transition = transition;
    }

    if (this.node.autofocus) {
      // Special case. Some browsers (*cough* Firefix *cough*) have a problem
      // with dynamically-generated elements having autofocus, and they won't
      // allow you to programmatically focus the element until it's in the DOM
      runloop.scheduleTask(function () {
        return _this.node.focus();
      }, true);
    }

    updateLiveQueries(this);
    return this.node;
  }

  function getNamespace(element) {
    var namespace, xmlns, parent;

    // Use specified namespace...
    if (xmlns = element.getAttribute("xmlns")) {
      namespace = xmlns;
    }

    // ...or SVG namespace, if this is an <svg> element
    else if (element.name === "svg") {
      namespace = namespaces.svg;
    } else if (parent = element.parent) {
      // ...or HTML, if the parent is a <foreignObject>
      if (parent.name === "foreignObject") {
        namespace = namespaces.html;
      }

      // ...or inherit from the parent node
      else {
        namespace = parent.node.namespaceURI;
      }
    } else {
      namespace = element.root.el.namespaceURI;
    }

    return namespace;
  }

  function processOption(option) {
    var optionValue, selectValue, i;

    if (!option.select) {
      return;
    }

    selectValue = option.select.getAttribute("value");
    if (selectValue === undefined) {
      return;
    }

    optionValue = option.getAttribute("value");

    if (option.select.node.multiple && isArray(selectValue)) {
      i = selectValue.length;
      while (i--) {
        if (optionValue == selectValue[i]) {
          option.node.selected = true;
          break;
        }
      }
    } else {
      option.node.selected = optionValue == selectValue;
    }
  }

  function updateLiveQueries(element) {
    var instance, liveQueries, i, selector, query;

    // Does this need to be added to any live queries?
    instance = element.root;

    do {
      liveQueries = instance._liveQueries;

      i = liveQueries.length;
      while (i--) {
        selector = liveQueries[i];
        query = liveQueries["_" + selector];

        if (query._test(element)) {
          // keep register of applicable selectors, for when we teardown
          (element.liveQueries || (element.liveQueries = [])).push(query);
        }
      }
    } while (instance = instance.parent);
  }
  //# sourceMappingURL=02-6to5-render.js.map

  var Element_prototype_toString = function () {
    var str, escape;

    if (this.template.y) {
      // DOCTYPE declaration
      return "<!DOCTYPE" + this.template.dd + ">";
    }

    str = "<" + this.template.e;

    str += this.attributes.map(stringifyAttribute).join("") + this.conditionalAttributes.map(stringifyAttribute).join("");

    // Special case - selected options
    if (this.name === "option" && optionIsSelected(this)) {
      str += " selected";
    }

    // Special case - two-way radio name bindings
    if (this.name === "input" && inputIsCheckedRadio(this)) {
      str += " checked";
    }

    str += ">";

    // Special case - textarea
    if (this.name === "textarea" && this.getAttribute("value") !== undefined) {
      str += escapeHtml(this.getAttribute("value"));
    }

    // Special case - contenteditable
    else if (this.getAttribute("contenteditable") !== undefined) {
      str += this.getAttribute("value");
    }

    if (this.fragment) {
      escape = this.name !== "script" && this.name !== "style";
      str += this.fragment.toString(escape);
    }

    // add a closing tag if this isn't a void element
    if (!voidElementNames.test(this.template.e)) {
      str += "</" + this.template.e + ">";
    }

    return str;
  };

  function optionIsSelected(element) {
    var optionValue, selectValue, i;

    optionValue = element.getAttribute("value");

    if (optionValue === undefined || !element.select) {
      return false;
    }

    selectValue = element.select.getAttribute("value");

    if (selectValue == optionValue) {
      return true;
    }

    if (element.select.getAttribute("multiple") && isArray(selectValue)) {
      i = selectValue.length;
      while (i--) {
        if (selectValue[i] == optionValue) {
          return true;
        }
      }
    }
  }

  function inputIsCheckedRadio(element) {
    var attributes, typeAttribute, valueAttribute, nameAttribute;

    attributes = element.attributes;

    typeAttribute = attributes.type;
    valueAttribute = attributes.value;
    nameAttribute = attributes.name;

    if (!typeAttribute || typeAttribute.value !== "radio" || !valueAttribute || !nameAttribute.interpolator) {
      return;
    }

    if (valueAttribute.value === nameAttribute.interpolator.value) {
      return true;
    }
  }

  function stringifyAttribute(attribute) {
    var str = attribute.toString();
    return str ? " " + str : "";
  }
  //# sourceMappingURL=02-6to5-toString.js.map

  function Element$unbind() {
    if (this.fragment) {
      this.fragment.unbind();
    }

    if (this.binding) {
      this.binding.unbind();
    }

    if (this.eventHandlers) {
      this.eventHandlers.forEach(methodCallers__unbind);
    }

    // Special case - <option>
    if (this.name === "option") {
      option__unbind(this);
    }

    this.attributes.forEach(methodCallers__unbind);
    this.conditionalAttributes.forEach(methodCallers__unbind);
  }
  //# sourceMappingURL=02-6to5-unbind.js.map

  function Element$unrender(shouldDestroy) {
    var binding, bindings, transition;

    if (transition = this.transition) {
      transition.complete();
    }

    // Detach as soon as we can
    if (this.name === "option") {
      // <option> elements detach immediately, so that
      // their parent <select> element syncs correctly, and
      // since option elements can't have transitions anyway
      this.detach();
    } else if (shouldDestroy) {
      runloop.detachWhenReady(this);
    }

    // Children first. that way, any transitions on child elements will be
    // handled by the current transitionManager
    if (this.fragment) {
      this.fragment.unrender(false);
    }

    if (binding = this.binding) {
      this.binding.unrender();

      this.node._ractive.binding = null;
      bindings = this.root._twowayBindings[binding.keypath.str];
      bindings.splice(bindings.indexOf(binding), 1);
    }

    // Remove event handlers
    if (this.eventHandlers) {
      this.eventHandlers.forEach(methodCallers__unrender);
    }

    if (this.decorator) {
      runloop.registerDecorator(this.decorator);
    }

    // trigger outro transition if necessary
    if (this.root.transitionsEnabled && this.outro) {
      transition = new Transition(this, this.outro, false);
      runloop.registerTransition(transition);
      runloop.scheduleTask(function () {
        return transition.start();
      });
    }

    // Remove this node from any live queries
    if (this.liveQueries) {
      removeFromLiveQueries(this);
    }

    if (this.name === "form") {
      form__unrender(this);
    }
  }

  function removeFromLiveQueries(element) {
    var query, selector, i;

    i = element.liveQueries.length;
    while (i--) {
      query = element.liveQueries[i];
      selector = query.selector;

      query._remove(element.node);
    }
  }
  //# sourceMappingURL=02-6to5-unrender.js.map

  var Element = function (options) {
    this.init(options);
  };

  Element.prototype = {
    bubble: Element_prototype_bubble,
    detach: Element$detach,
    find: Element_prototype_find,
    findAll: Element_prototype_findAll,
    findAllComponents: Element_prototype_findAllComponents,
    findComponent: Element_prototype_findComponent,
    findNextNode: Element$findNextNode,
    firstNode: Element$firstNode,
    getAttribute: Element$getAttribute,
    init: Element$init,
    rebind: Element$rebind,
    render: Element$render,
    toString: Element_prototype_toString,
    unbind: Element$unbind,
    unrender: Element$unrender
  };


  //# sourceMappingURL=02-6to5-_Element.js.map

  var deIndent__empty = /^\s*$/,
      deIndent__leadingWhitespace = /^\s*/;

  var deIndent = function (str) {
    var lines, firstLine, lastLine, minIndent;

    lines = str.split("\n");

    // remove first and last line, if they only contain whitespace
    firstLine = lines[0];
    if (firstLine !== undefined && deIndent__empty.test(firstLine)) {
      lines.shift();
    }

    lastLine = lastItem(lines);
    if (lastLine !== undefined && deIndent__empty.test(lastLine)) {
      lines.pop();
    }

    minIndent = lines.reduce(reducer, null);

    if (minIndent) {
      str = lines.map(function (line) {
        return line.replace(minIndent, "");
      }).join("\n");
    }

    return str;
  };

  function reducer(previous, line) {
    var lineIndent = deIndent__leadingWhitespace.exec(line)[0];

    if (previous === null || lineIndent.length < previous.length) {
      return lineIndent;
    }

    return previous;
  }
  //# sourceMappingURL=02-6to5-deIndent.js.map

  function getPartialTemplate(ractive, name) {
    var partial;

    // If the partial in instance or view heirarchy instances, great
    if (partial = getPartialFromRegistry(ractive, name)) {
      return partial;
    }

    // Does it exist on the page as a script tag?
    partial = parser__default.fromId(name, { noThrow: true });

    if (partial) {
      // is this necessary?
      partial = deIndent(partial);

      // parse and register to this ractive instance
      var parsed = parser__default.parse(partial, parser__default.getParseOptions(ractive));

      // register (and return main partial if there are others in the template)
      return ractive.partials[name] = parsed.t;
    }
  }

  function getPartialFromRegistry(ractive, name) {
    // find first instance in the ractive or view hierarchy that has this partial
    var instance = findInstance("partials", ractive, name);

    if (!instance) {
      return;
    }

    var partial = instance.partials[name],
        fn = undefined;

    // partial is a function?
    if (typeof partial === "function") {
      fn = partial.bind(instance);
      fn.isOwner = instance.partials.hasOwnProperty(name);
      partial = fn(instance.data, parser__default);
    }

    if (!partial && partial !== "") {
      warn(noRegistryFunctionReturn, name, "partial", "partial");
      return;
    }

    // If this was added manually to the registry,
    // but hasn't been parsed, parse it now
    if (!parser__default.isParsed(partial)) {
      // use the parseOptions of the ractive instance on which it was found
      var parsed = parser__default.parse(partial, parser__default.getParseOptions(instance));

      // Partials cannot contain nested partials!
      // TODO add a test for this
      if (parsed.p) {
        warn("Partials ({{>%s}}) cannot contain nested inline partials", name);
      }

      // if fn, use instance to store result, otherwise needs to go
      // in the correct point in prototype chain on instance or constructor
      var target = fn ? instance : findOwner(instance, name);

      // may be a template with partials, which need to be registered and main template extracted
      target.partials[name] = partial = parsed.t;
    }

    // store for reset
    if (fn) {
      partial._fn = fn;
    }

    return partial.v ? partial.t : partial;
  }

  function findOwner(ractive, key) {
    return ractive.partials.hasOwnProperty(key) ? ractive : findConstructor(ractive.constructor, key);
  }

  function findConstructor(constructor, key) {
    if (!constructor) {
      return;
    }
    return constructor.partials.hasOwnProperty(key) ? constructor : findConstructor(constructor._Parent, key);
  }
  //# sourceMappingURL=02-6to5-getPartialTemplate.js.map

  var applyIndent = function (string, indent) {
    var indented;

    if (!indent) {
      return string;
    }

    indented = string.split("\n").map(function (line, notFirstLine) {
      return notFirstLine ? indent + line : line;
    }).join("\n");

    return indented;
  };
  //# sourceMappingURL=02-6to5-applyIndent.js.map

  var Partial = function (options) {
    var parentFragment, template;

    parentFragment = this.parentFragment = options.parentFragment;

    this.root = parentFragment.root;
    this.type = PARTIAL;
    this.index = options.index;
    this.name = options.template.r;

    this.fragment = this.fragmentToRender = this.fragmentToUnrender = null;

    Mustache.init(this, options);

    // If this didn't resolve, it most likely means we have a named partial
    // (i.e. `{{>foo}}` means 'use the foo partial', not 'use the partial
    // whose name is the value of `foo`')
    if (!this.keypath && (template = getPartialTemplate(this.root, this.name))) {
      unbind__unbind.call(this); // prevent any further changes
      this.isNamed = true;

      this.setTemplate(template);
    }
  };

  Partial.prototype = {
    bubble: function () {
      this.parentFragment.bubble();
    },

    detach: function () {
      return this.fragment.detach();
    },

    find: function (selector) {
      return this.fragment.find(selector);
    },

    findAll: function (selector, query) {
      return this.fragment.findAll(selector, query);
    },

    findComponent: function (selector) {
      return this.fragment.findComponent(selector);
    },

    findAllComponents: function (selector, query) {
      return this.fragment.findAllComponents(selector, query);
    },

    firstNode: function () {
      return this.fragment.firstNode();
    },

    findNextNode: function () {
      return this.parentFragment.findNextNode(this);
    },

    getPartialName: function () {
      if (this.isNamed && this.name) return this.name;else if (this.value === undefined) return this.name;else return this.value;
    },

    getValue: function () {
      return this.fragment.getValue();
    },

    rebind: function (oldKeypath, newKeypath) {
      // named partials aren't bound, so don't rebind
      if (!this.isNamed) {
        Mustache$rebind.call(this, oldKeypath, newKeypath);
      }

      this.fragment.rebind(oldKeypath, newKeypath);
    },

    render: function () {
      this.docFrag = document.createDocumentFragment();
      this.update();

      this.rendered = true;
      return this.docFrag;
    },

    resolve: Mustache.resolve,

    setValue: function (value) {
      var template;

      if (value !== undefined && value === this.value) {
        // nothing has changed, so no work to be done
        return;
      }

      if (value !== undefined) {
        template = getPartialTemplate(this.root, "" + value);
      }

      // we may be here if we have a partial like `{{>foo}}` and `foo` is the
      // name of both a data property (whose value ISN'T the name of a partial)
      // and a partial. In those cases, this becomes a named partial
      if (!template && this.name && (template = getPartialTemplate(this.root, this.name))) {
        unbind__unbind.call(this);
        this.isNamed = true;
      }

      if (!template) {
        (this.root.debug ? fatal : warnOnce)("Could not find template for partial \"%s\"", this.name);
      }

      this.value = value;

      this.setTemplate(template || []);

      this.bubble();

      if (this.rendered) {
        runloop.addView(this);
      }
    },

    setTemplate: function (template) {
      if (this.fragment) {
        this.fragment.unbind();
        this.fragmentToUnrender = this.fragment;
      }

      this.fragment = new Fragment({
        template: template,
        root: this.root,
        owner: this,
        pElement: this.parentFragment.pElement
      });

      this.fragmentToRender = this.fragment;
    },

    toString: function (toString) {
      var string, previousItem, lastLine, match;

      string = this.fragment.toString(toString);

      previousItem = this.parentFragment.items[this.index - 1];

      if (!previousItem || previousItem.type !== TEXT) {
        return string;
      }

      lastLine = previousItem.text.split("\n").pop();

      if (match = /^\s+$/.exec(lastLine)) {
        return applyIndent(string, match[0]);
      }

      return string;
    },

    unbind: function () {
      if (!this.isNamed) {
        // dynamic partial - need to unbind self
        unbind__unbind.call(this);
      }

      if (this.fragment) {
        this.fragment.unbind();
      }
    },

    unrender: function (shouldDestroy) {
      if (this.rendered) {
        if (this.fragment) {
          this.fragment.unrender(shouldDestroy);
        }
        this.rendered = false;
      }
    },

    update: function () {
      var target, anchor;

      if (this.fragmentToUnrender) {
        this.fragmentToUnrender.unrender(true);
        this.fragmentToUnrender = null;
      }

      if (this.fragmentToRender) {
        this.docFrag.appendChild(this.fragmentToRender.render());
        this.fragmentToRender = null;
      }

      if (this.rendered) {
        target = this.parentFragment.getNode();
        anchor = this.parentFragment.findNextNode(this);
        target.insertBefore(this.docFrag, anchor);
      }
    }
  };


  //# sourceMappingURL=02-6to5-_Partial.js.map

  function getComponent__getComponent(ractive, name) {
    var Component,
        instance = findInstance("components", ractive, name);

    if (instance) {
      Component = instance.components[name];

      // best test we have for not Ractive.extend
      if (!Component._Parent) {
        // function option, execute and store for reset
        var fn = Component.bind(instance);
        fn.isOwner = instance.components.hasOwnProperty(name);
        Component = fn(instance.data);

        if (!Component) {
          if (ractive.debug) {
            warn(noRegistryFunctionReturn, name, "component", "component");
          }

          return;
        }

        if (typeof Component === "string") {
          // allow string lookup
          Component = getComponent__getComponent(ractive, Component);
        }

        Component._fn = fn;
        instance.components[name] = Component;
      }
    }

    return Component;
  }
  //# sourceMappingURL=02-6to5-getComponent.js.map

  var Component_prototype_detach__detachHook = new Hook("detach");

  function Component$detach() {
    var detached = this.instance.fragment.detach();
    Component_prototype_detach__detachHook.fire(this.instance);
    return detached;
  }
  //# sourceMappingURL=02-6to5-detach.js.map

  function Component$find(selector) {
    return this.instance.fragment.find(selector);
  }
  //# sourceMappingURL=02-6to5-find.js.map

  function Component$findAll(selector, query) {
    return this.instance.fragment.findAll(selector, query);
  }
  //# sourceMappingURL=02-6to5-findAll.js.map

  function Component$findAllComponents(selector, query) {
    query._test(this, true);

    if (this.instance.fragment) {
      this.instance.fragment.findAllComponents(selector, query);
    }
  }
  //# sourceMappingURL=02-6to5-findAllComponents.js.map

  function Component$findComponent(selector) {
    if (!selector || selector === this.name) {
      return this.instance;
    }

    if (this.instance.fragment) {
      return this.instance.fragment.findComponent(selector);
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-findComponent.js.map

  function Component$findNextNode() {
    return this.parentFragment.findNextNode(this);
  }
  //# sourceMappingURL=02-6to5-findNextNode.js.map

  function Component$firstNode() {
    if (this.rendered) {
      return this.instance.fragment.firstNode();
    }

    return null;
  }
  //# sourceMappingURL=02-6to5-firstNode.js.map

  var prefixers = {};

  function Viewmodel$adapt(keypath, value) {
    var ractive = this.ractive,
        len,
        i,
        adaptor,
        wrapped;

    // Do we have an adaptor for this value?
    len = ractive.adapt.length;
    for (i = 0; i < len; i += 1) {
      adaptor = ractive.adapt[i];

      if (adaptor.filter(value, keypath, ractive)) {
        wrapped = this.wrapped[keypath] = adaptor.wrap(ractive, value, keypath, getPrefixer(keypath));
        wrapped.value = value;
        return value;
      }
    }

    return value;
  }

  function prefixKeypath(obj, prefix) {
    var prefixed = {},
        key;

    if (!prefix) {
      return obj;
    }

    prefix += ".";

    for (key in obj) {
      if (obj.hasOwnProperty(key)) {
        prefixed[prefix + key] = obj[key];
      }
    }

    return prefixed;
  }

  function getPrefixer(rootKeypath) {
    var rootDot;

    if (!prefixers[rootKeypath]) {
      rootDot = rootKeypath ? rootKeypath + "." : "";

      prefixers[rootKeypath] = function (relativeKeypath, value) {
        var obj;

        if (typeof relativeKeypath === "string") {
          obj = {};
          obj[rootDot + relativeKeypath] = value;
          return obj;
        }

        if (typeof relativeKeypath === "object") {
          // 'relativeKeypath' is in fact a hash, not a keypath
          return rootDot ? prefixKeypath(relativeKeypath, rootKeypath) : relativeKeypath;
        }
      };
    }

    return prefixers[rootKeypath];
  }
  //# sourceMappingURL=02-6to5-adapt.js.map

  function getUpstreamChanges(changes) {
    var upstreamChanges = [rootKeypath],
        i,
        keypath;

    i = changes.length;
    while (i--) {
      keypath = changes[i].parent;

      while (keypath && !keypath.isRoot) {
        addToArray(upstreamChanges, keypath);
        keypath = keypath.parent;
      }
    }

    return upstreamChanges;
  }
  //# sourceMappingURL=02-6to5-getUpstreamChanges.js.map

  function notifyPatternObservers(viewmodel, keypath, onlyDirect) {
    var potentialWildcardMatches;

    updateMatchingPatternObservers(viewmodel, keypath);

    if (onlyDirect) {
      return;
    }

    potentialWildcardMatches = keypath.wildcardMatches();
    potentialWildcardMatches.forEach(function (upstreamPattern) {
      cascade(viewmodel, upstreamPattern, keypath);
    });
  }


  function cascade(viewmodel, upstreamPattern, keypath) {
    var group, map, actualChildKeypath;

    // TODO should be one or the other
    upstreamPattern = upstreamPattern.str || upstreamPattern;

    group = viewmodel.depsMap.patternObservers;
    map = group && group[upstreamPattern];

    if (!map) {
      return;
    }

    map.forEach(function (childKeypath) {
      actualChildKeypath = keypath.join(childKeypath.lastKey); // 'foo.bar.baz'

      updateMatchingPatternObservers(viewmodel, actualChildKeypath);
      cascade(viewmodel, childKeypath, actualChildKeypath);
    });
  }

  function updateMatchingPatternObservers(viewmodel, keypath) {
    viewmodel.patternObservers.forEach(function (observer) {
      if (observer.regex.test(keypath.str)) {
        observer.update(keypath);
      }
    });
  }
  //# sourceMappingURL=02-6to5-notifyPatternObservers.js.map

  function Viewmodel$applyChanges() {
    var _this = this;
    var cascade = function (keypath) {
      var map, computations;

      if (self.noCascade.hasOwnProperty(keypath.str)) {
        return;
      }

      if (computations = self.deps.computed[keypath.str]) {
        computations.forEach(function (c) {
          var key = c.key;

          if (c.viewmodel === self) {
            self.clearCache(key.str);
            c.invalidate();

            changes.push(key);
            cascade(key);
          } else {
            c.viewmodel.mark(key);
          }
        });
      }

      if (map = self.depsMap.computed[keypath.str]) {
        map.forEach(cascade);
      }
    };

    var self = this,
        changes,
        upstreamChanges,
        hash = {},
        bindings;

    changes = this.changes;

    if (!changes.length) {
      // TODO we end up here on initial render. Perhaps we shouldn't?
      return;
    }

    changes.slice().forEach(cascade);

    upstreamChanges = getUpstreamChanges(changes);
    upstreamChanges.forEach(function (keypath) {
      var computations;

      // make sure we haven't already been down this particular keypath in this turn
      if (changes.indexOf(keypath) === -1 && (computations = self.deps.computed[keypath.str])) {
        _this.changes.push(keypath);

        computations.forEach(function (c) {
          c.viewmodel.mark(c.key);
        });
      }
    });

    this.changes = [];

    // Pattern observers are a weird special case
    if (this.patternObservers.length) {
      upstreamChanges.forEach(function (keypath) {
        return notifyPatternObservers(_this, keypath, true);
      });
      changes.forEach(function (keypath) {
        return notifyPatternObservers(_this, keypath);
      });
    }

    if (this.deps.observers) {
      upstreamChanges.forEach(function (keypath) {
        return notifyUpstreamDependants(_this, null, keypath, "observers");
      });
      notifyAllDependants(this, changes, "observers");
    }

    if (this.deps["default"]) {
      bindings = [];
      upstreamChanges.forEach(function (keypath) {
        return notifyUpstreamDependants(_this, bindings, keypath, "default");
      });

      if (bindings.length) {
        notifyBindings(this, bindings, changes);
      }

      notifyAllDependants(this, changes, "default");
    }

    // Return a hash of keypaths to updated values
    changes.forEach(function (keypath) {
      hash[keypath.str] = _this.get(keypath);
    });

    this.implicitChanges = {};
    this.noCascade = {};

    return hash;
  }

  function notifyUpstreamDependants(viewmodel, bindings, keypath, groupName) {
    var dependants, value;

    if (dependants = findDependants(viewmodel, keypath, groupName)) {
      value = viewmodel.get(keypath);

      dependants.forEach(function (d) {
        // don't "set" the parent value, refine it
        // i.e. not data = value, but data[foo] = fooValue
        if (bindings && d.refineValue) {
          bindings.push(d);
        } else {
          d.setValue(value);
        }
      });
    }
  }

  function notifyBindings(viewmodel, bindings, changes) {
    bindings.forEach(function (binding) {
      var useSet = false,
          i = 0,
          length = changes.length,
          refinements = [];

      while (i < length) {
        var keypath = changes[i];

        if (keypath === binding.keypath) {
          useSet = true;
          break;
        }

        if (keypath.slice(0, binding.keypath.length) === binding.keypath) {
          refinements.push(keypath);
        }

        i++;
      }

      if (useSet) {
        binding.setValue(viewmodel.get(binding.keypath));
      }

      if (refinements.length) {
        binding.refineValue(refinements);
      }
    });
  }


  function notifyAllDependants(viewmodel, keypaths, groupName) {
    var addKeypaths = function (keypaths) {
      keypaths.forEach(addKeypath);
      keypaths.forEach(cascade);
    };

    var addKeypath = function (keypath) {
      var deps = findDependants(viewmodel, keypath, groupName);

      if (deps) {
        queue.push({
          keypath: keypath,
          deps: deps
        });
      }
    };

    var cascade = function (keypath) {
      var childDeps;

      if (childDeps = viewmodel.depsMap[groupName][keypath.str]) {
        addKeypaths(childDeps);
      }
    };

    var dispatch = function (set) {
      var value = viewmodel.get(set.keypath);
      set.deps.forEach(function (d) {
        return d.setValue(value);
      });
    };

    var queue = [];

    addKeypaths(keypaths);
    queue.forEach(dispatch);
  }

  function findDependants(viewmodel, keypath, groupName) {
    var group = viewmodel.deps[groupName];
    return group ? group[keypath.str] : null;
  }
  //# sourceMappingURL=02-6to5-applyChanges.js.map

  function Viewmodel$capture() {
    this.captureGroups.push([]);
  }
  //# sourceMappingURL=02-6to5-capture.js.map

  function Viewmodel$clearCache(keypath, keepExistingWrapper) {
    var cacheMap, wrapper;

    if (!keepExistingWrapper) {
      // Is there a wrapped property at this keypath?
      if (wrapper = this.wrapped[keypath]) {
        // Did we unwrap it?
        if (wrapper.teardown() !== false) {
          // Is this right?
          // What's the meaning of returning false from teardown?
          // Could there be a GC ramification if this is a "real" ractive.teardown()?
          this.wrapped[keypath] = null;
        }
      }
    }

    this.cache[keypath] = undefined;

    if (cacheMap = this.cacheMap[keypath]) {
      while (cacheMap.length) {
        this.clearCache(cacheMap.pop());
      }
    }
  }
  //# sourceMappingURL=02-6to5-clearCache.js.map

  var getComputationSignature__pattern = /\$\{([^\}]+)\}/g;

  var getComputationSignature = function (signature) {
    if (typeof signature === "function") {
      return { get: signature };
    }

    if (typeof signature === "string") {
      return {
        get: createFunctionFromString(signature)
      };
    }

    if (typeof signature === "object" && typeof signature.get === "string") {
      signature = {
        get: createFunctionFromString(signature.get),
        set: signature.set
      };
    }

    return signature;
  };

  function createFunctionFromString(signature) {
    var functionBody = "var __ractive=this;return(" + signature.replace(getComputationSignature__pattern, function (match, keypath) {
      return "__ractive.get(\"" + keypath + "\")";
    }) + ")";

    return new Function(functionBody);
  }
  //# sourceMappingURL=02-6to5-getComputationSignature.js.map

  var UnresolvedDependency = function (computation, ref) {
    this.computation = computation;
    this.viewmodel = computation.viewmodel;
    this.ref = ref;

    // TODO this seems like a red flag!
    this.root = this.viewmodel.ractive;
    this.parentFragment = this.root.component && this.root.component.parentFragment;
  };

  UnresolvedDependency.prototype = {
    resolve: function (keypath) {
      this.computation.softDeps.push(keypath);
      this.computation.unresolvedDeps[keypath.str] = null;
      this.viewmodel.register(keypath, this.computation, "computed");
    }
  };


  //# sourceMappingURL=02-6to5-UnresolvedDependency.js.map

  var Computation = function (ractive, key, signature) {
    var _this = this;
    this.ractive = ractive;
    this.viewmodel = ractive.viewmodel;
    this.key = key;

    this.getter = signature.get;
    this.setter = signature.set;

    this.hardDeps = signature.deps || [];
    this.softDeps = [];
    this.unresolvedDeps = {};

    this.depValues = {};

    if (this.hardDeps) {
      this.hardDeps.forEach(function (d) {
        return ractive.viewmodel.register(d, _this, "computed");
      });
    }

    this._dirty = this._firstRun = true;
  };

  Computation.prototype = {
    constructor: Computation,

    init: function () {
      var initial;

      this.bypass = true;

      initial = this.ractive.viewmodel.get(this.key);
      this.ractive.viewmodel.clearCache(this.key.str);

      this.bypass = false;

      if (this.setter && initial !== undefined) {
        this.set(initial);
      }
    },

    invalidate: function () {
      this._dirty = true;
    },

    get: function () {
      var _this2 = this;
      var ractive,
          newDeps,
          dependenciesChanged,
          dependencyValuesChanged = false;

      if (this.getting) {
        // prevent double-computation (e.g. caused by array mutation inside computation)
        return;
      }

      this.getting = true;

      if (this._dirty) {
        ractive = this.ractive;

        // determine whether the inputs have changed, in case this depends on
        // other computed values
        if (this._firstRun || !this.hardDeps.length && !this.softDeps.length) {
          dependencyValuesChanged = true;
        } else {
          [this.hardDeps, this.softDeps].forEach(function (deps) {
            var keypath, value, i;

            if (dependencyValuesChanged) {
              return;
            }

            i = deps.length;
            while (i--) {
              keypath = deps[i];
              value = ractive.viewmodel.get(keypath);

              if (!isEqual(value, _this2.depValues[keypath.str])) {
                _this2.depValues[keypath.str] = value;
                dependencyValuesChanged = true;

                return;
              }
            }
          });
        }

        if (dependencyValuesChanged) {
          ractive.viewmodel.capture();

          try {
            this.value = this.getter.call(ractive);
          } catch (err) {
            if (ractive.debug) {
              warn("Failed to compute \"%s\"", this.key.str);
              log(err.stack || err);
            }

            this.value = void 0;
          }

          newDeps = ractive.viewmodel.release();
          dependenciesChanged = this.updateDependencies(newDeps);

          if (dependenciesChanged) {
            [this.hardDeps, this.softDeps].forEach(function (deps) {
              deps.forEach(function (keypath) {
                _this2.depValues[keypath.str] = ractive.viewmodel.get(keypath);
              });
            });
          }
        }

        this._dirty = false;
      }

      this.getting = this._firstRun = false;
      return this.value;
    },

    set: function (value) {
      if (this.setting) {
        this.value = value;
        return;
      }

      if (!this.setter) {
        throw new Error("Computed properties without setters are read-only. (This may change in a future version of Ractive!)");
      }

      this.setter.call(this.ractive, value);
    },

    updateDependencies: function (newDeps) {
      var i, oldDeps, keypath, dependenciesChanged, unresolved;

      oldDeps = this.softDeps;

      // remove dependencies that are no longer used
      i = oldDeps.length;
      while (i--) {
        keypath = oldDeps[i];

        if (newDeps.indexOf(keypath) === -1) {
          dependenciesChanged = true;
          this.viewmodel.unregister(keypath, this, "computed");
        }
      }

      // create references for any new dependencies
      i = newDeps.length;
      while (i--) {
        keypath = newDeps[i];

        if (oldDeps.indexOf(keypath) === -1 && (!this.hardDeps || this.hardDeps.indexOf(keypath) === -1)) {
          dependenciesChanged = true;

          // if this keypath is currently unresolved, we need to mark
          // it as such. TODO this is a bit muddy...
          if (isUnresolved(this.viewmodel, keypath) && !this.unresolvedDeps[keypath.str]) {
            unresolved = new UnresolvedDependency(this, keypath.str);
            newDeps.splice(i, 1);

            this.unresolvedDeps[keypath.str] = unresolved;
            runloop.addUnresolved(unresolved);
          } else {
            this.viewmodel.register(keypath, this, "computed");
          }
        }
      }

      if (dependenciesChanged) {
        this.softDeps = newDeps.slice();
      }

      return dependenciesChanged;
    }
  };

  function isUnresolved(viewmodel, keypath) {
    var key = keypath.firstKey;

    return !(key in viewmodel.ractive.data) && !(key in viewmodel.computations) && !(key in viewmodel.mappings);
  }


  //# sourceMappingURL=02-6to5-Computation.js.map

  function Viewmodel$compute(key, signature) {
    signature = getComputationSignature(signature);
    return this.computations[key.str] = new Computation(this.ractive, key, signature);
  }
  //# sourceMappingURL=02-6to5-compute.js.map

  var FAILED_LOOKUP = { FAILED_LOOKUP: true };
  //# sourceMappingURL=02-6to5-FAILED_LOOKUP.js.map

  var get__empty = {};

  function Viewmodel$get(keypath, options) {
    var ractive = this.ractive,
        cache = this.cache,
        mapping,
        value,
        computation,
        wrapped,
        captureGroup,
        keypathStr = keypath.str;

    options = options || get__empty;

    // capture the keypath, if we're inside a computation
    if (options.capture && (captureGroup = lastItem(this.captureGroups))) {
      if (! ~captureGroup.indexOf(keypath)) {
        captureGroup.push(keypath);
      }
    }

    if (mapping = this.mappings[keypath.firstKey]) {
      return mapping.get(keypath, options);
    }

    if (keypath.isSpecial) {
      return keypath.value;
    }

    if (cache[keypathStr] === undefined) {
      // Is this a computed property?
      if ((computation = this.computations[keypathStr]) && !computation.bypass) {
        value = computation.get();
        this.adapt(keypathStr, value);
      }

      // Is this a wrapped property?
      else if (wrapped = this.wrapped[keypathStr]) {
        value = wrapped.value;
      }

      // Is it the root?
      else if (keypath.isRoot) {
        this.adapt("", ractive.data);
        value = ractive.data;
      }

      // No? Then we need to retrieve the value one key at a time
      else {
        value = retrieve(this, keypath);
      }

      cache[keypathStr] = value;
    } else {
      value = cache[keypathStr];
    }

    if (!options.noUnwrap && (wrapped = this.wrapped[keypathStr])) {
      value = wrapped.get();
    }

    return value === FAILED_LOOKUP ? void 0 : value;
  }

  function retrieve(viewmodel, keypath) {
    var parentValue, cacheMap, value, wrapped;

    parentValue = viewmodel.get(keypath.parent);

    if (wrapped = viewmodel.wrapped[keypath.parent.str]) {
      parentValue = wrapped.get();
    }

    if (parentValue === null || parentValue === undefined) {
      return;
    }

    // update cache map
    if (!(cacheMap = viewmodel.cacheMap[keypath.parent.str])) {
      viewmodel.cacheMap[keypath.parent.str] = [keypath.str];
    } else {
      if (cacheMap.indexOf(keypath.str) === -1) {
        cacheMap.push(keypath.str);
      }
    }

    // If this property doesn't exist, we return a sentinel value
    // so that we know to query parent scope (if such there be)
    if (typeof parentValue === "object" && !(keypath.lastKey in parentValue)) {
      return viewmodel.cache[keypath.str] = FAILED_LOOKUP;
    }

    value = parentValue[keypath.lastKey];

    // Do we have an adaptor for this value?
    viewmodel.adapt(keypath.str, value, false);

    // Update cache
    viewmodel.cache[keypath.str] = value;
    return value;
  }
  //# sourceMappingURL=02-6to5-get.js.map

  function Viewmodel$init() {
    var key,
        computation,
        computations = [];

    for (key in this.ractive.computed) {
      computation = this.compute(getKeypath(key), this.ractive.computed[key]);
      computations.push(computation);

      if (key in this.mappings) {
        fatal("Cannot map to a computed property ('%s')", key);
      }
    }

    computations.forEach(viewmodel_prototype_init__init);
  }

  function viewmodel_prototype_init__init(computation) {
    computation.init();
  }
  //# sourceMappingURL=02-6to5-init.js.map

  function DataTracker(key, viewmodel) {
    this.keypath = key;
    this.viewmodel = viewmodel;
  }



  DataTracker.prototype.setValue = function (value) {
    this.viewmodel.set(this.keypath, value, { noMapping: true });
  };
  //# sourceMappingURL=02-6to5-DataTracker.js.map

  function Mapping(localKey, options) {
    this.localKey = localKey;
    this.keypath = options.keypath;
    this.origin = options.origin;

    if (options.force) {
      this.force = options.force;
    }

    this.deps = [];
    this.unresolved = [];

    this.trackData = options.trackData;
    this.resolved = false;
  }



  Mapping.prototype = {
    ensureKeypath: function ensureKeypath() {
      if (!this.keypath) {
        if (isFunction(this.force)) {
          this.force();
        }

        if (!this.keypath) {
          throw new Error("Mapping \"" + this.localKey.str + "\" on component \"" + this.local.ractive.component.name + "\" does not have a keypath. This is usually caused by an ambiguous complex reference, which can usually be fixed by scoping your references.");
        }
      }
    },

    get: function get(keypath, options) {
      if (!this.resolved) {
        return undefined;
      }
      return this.origin.get(this.map(keypath), options);
    },

    getValue: function Mapping__getValue() {
      if (!this.keypath) {
        return undefined;
      }
      return this.origin.get(this.keypath);
    },

    initViewmodel: function initViewmodel(viewmodel) {
      this.local = viewmodel;
      this.setup();
    },

    map: function Mapping__map(keypath) {
      return keypath.replace(this.localKey, this.keypath);
    },

    register: function register(keypath, dependant, group) {
      this.deps.push({ keypath: keypath, dep: dependant, group: group });

      if (this.resolved) {
        this.origin.register(this.map(keypath), dependant, group);
      }
    },

    resolve: function Mapping__resolve(keypath) {
      if (this.keypath !== undefined) {
        this.unbind(true);
      }

      this.keypath = keypath;
      this.setup();
    },

    set: function set(keypath, value) {
      this.ensureKeypath();
      this.origin.set(this.map(keypath), value);
    },

    setup: function setup() {
      var _this = this;
      if (this.keypath === undefined) {
        return;
      }

      this.resolved = true;

      // keep local data in sync, for browsers w/ no defineProperty
      if (this.trackData) {
        this.tracker = new DataTracker(this.localKey, this.local);
        this.origin.register(this.keypath, this.tracker);
      }

      // accumulated dependants can now be registered
      if (this.deps.length) {
        this.deps.forEach(function (d) {
          var keypath = _this.map(d.keypath);
          _this.origin.register(keypath, d.dep, d.group);

          // if the dep has a setter, it's a reference, otherwise, a computation
          if (isFunction(d.dep.setValue)) {
            d.dep.setValue(_this.origin.get(keypath));
          } else {
            // computations have no setter, get it to recompute via viewmodel
            _this.local.mark(d.dep.key);
          }
        });

        this.origin.mark(this.keypath);
      }
    },

    setValue: function Mapping__setValue(value) {
      this.ensureKeypath();
      this.origin.set(this.keypath, value);
    },

    unbind: function Mapping__unbind(keepLocal) {
      var _this2 = this;
      if (!keepLocal) {
        delete this.local.mappings[this.localKey];
      }

      this.deps.forEach(function (d) {
        _this2.origin.unregister(_this2.map(d.keypath), d.dep, d.group);
      });

      if (this.tracker) {
        this.origin.unregister(this.keypath, this.tracker);
      }
    },

    unregister: function unregister(keypath, dependant, group) {
      var deps = this.deps,
          i = deps.length;

      while (i--) {
        if (deps[i].dep === dependant) {
          deps.splice(i, 1);
          break;
        }
      }
      this.origin.unregister(this.map(keypath), dependant, group);
    }
  };
  //# sourceMappingURL=02-6to5-Mapping.js.map

  function Viewmodel$map(key, options) {
    var mapping = this.mappings[key.str] = new Mapping(key, options);
    mapping.initViewmodel(this);
    return mapping;
  }
  //# sourceMappingURL=02-6to5-map.js.map

  function Viewmodel$mark(keypath, options) {
    var computation,
        keypathStr = keypath.str;

    runloop.addViewmodel(this); // TODO remove other instances of this call

    // implicit changes (i.e. `foo.length` on `ractive.push('foo',42)`)
    // should not be picked up by pattern observers
    if (options) {
      if (options.implicit) {
        this.implicitChanges[keypathStr] = true;
      }
      if (options.noCascade) {
        this.noCascade[keypathStr] = true;
      }
    }

    if (computation = this.computations[keypathStr]) {
      computation.invalidate();
    }

    if (this.changes.indexOf(keypath) === -1) {
      this.changes.push(keypath);
    }

    // pass on keepExistingWrapper, if we can
    var keepExistingWrapper = options ? options.keepExistingWrapper : false;

    this.clearCache(keypathStr, keepExistingWrapper);
  }
  //# sourceMappingURL=02-6to5-mark.js.map

  var mapOldToNewIndex = function (oldArray, newArray) {
    var usedIndices, firstUnusedIndex, newIndices, changed;

    usedIndices = {};
    firstUnusedIndex = 0;

    newIndices = oldArray.map(function (item, i) {
      var index, start, len;

      start = firstUnusedIndex;
      len = newArray.length;

      do {
        index = newArray.indexOf(item, start);

        if (index === -1) {
          changed = true;
          return -1;
        }

        start = index + 1;
      } while (usedIndices[index] && start < len);

      // keep track of the first unused index, so we don't search
      // the whole of newArray for each item in oldArray unnecessarily
      if (index === firstUnusedIndex) {
        firstUnusedIndex += 1;
      }

      if (index !== i) {
        changed = true;
      }

      usedIndices[index] = true;
      return index;
    });

    return newIndices;
  };
  //# sourceMappingURL=02-6to5-mapOldToNewIndex.js.map

  var comparators = {};

  function Viewmodel$merge(keypath, currentArray, array, options) {
    var oldArray, newArray, comparator, newIndices;

    this.mark(keypath);

    if (options && options.compare) {
      comparator = getComparatorFunction(options.compare);

      try {
        oldArray = currentArray.map(comparator);
        newArray = array.map(comparator);
      } catch (err) {
        // fallback to an identity check - worst case scenario we have
        // to do more DOM manipulation than we thought...

        // ...unless we're in debug mode of course
        if (this.debug) {
          throw err;
        } else {
          warn("Merge operation: comparison failed. Falling back to identity checking");
        }

        oldArray = currentArray;
        newArray = array;
      }
    } else {
      oldArray = currentArray;
      newArray = array;
    }

    // find new indices for members of oldArray
    newIndices = mapOldToNewIndex(oldArray, newArray);

    this.smartUpdate(keypath, array, newIndices, currentArray.length !== array.length);
  }

  function stringify(item) {
    return JSON.stringify(item);
  }

  function getComparatorFunction(comparator) {
    // If `compare` is `true`, we use JSON.stringify to compare
    // objects that are the same shape, but non-identical - i.e.
    // { foo: 'bar' } !== { foo: 'bar' }
    if (comparator === true) {
      return stringify;
    }

    if (typeof comparator === "string") {
      if (!comparators[comparator]) {
        comparators[comparator] = function (item) {
          return item[comparator];
        };
      }

      return comparators[comparator];
    }

    if (typeof comparator === "function") {
      return comparator;
    }

    throw new Error("The `compare` option must be a function, or a string representing an identifying field (or `true` to use JSON.stringify)");
  }
  //# sourceMappingURL=02-6to5-merge.js.map

  function Viewmodel$register(keypath, dependant) {
    var group = arguments[2] === undefined ? "default" : arguments[2];
    var mapping, depsByKeypath, deps;

    if (dependant.isStatic) {
      return; // TODO we should never get here if a dependant is static...
    }

    if (mapping = this.mappings[keypath.firstKey]) {
      mapping.register(keypath, dependant, group);
    } else {
      depsByKeypath = this.deps[group] || (this.deps[group] = {});
      deps = depsByKeypath[keypath.str] || (depsByKeypath[keypath.str] = []);

      deps.push(dependant);

      if (!keypath.isRoot) {
        register__updateDependantsMap(this, keypath, group);
      }
    }
  }

  function register__updateDependantsMap(viewmodel, keypath, group) {
    var map, parent, keypathStr;

    // update dependants map
    while (!keypath.isRoot) {
      map = viewmodel.depsMap[group] || (viewmodel.depsMap[group] = {});
      parent = map[keypath.parent.str] || (map[keypath.parent.str] = []);

      keypathStr = keypath.str;

      // TODO find an alternative to this nasty approach
      if (parent["_" + keypathStr] === undefined) {
        parent["_" + keypathStr] = 0;
        parent.push(keypath);
      }

      parent["_" + keypathStr] += 1;
      keypath = keypath.parent;
    }
  }
  //# sourceMappingURL=02-6to5-register.js.map

  function Viewmodel$release() {
    return this.captureGroups.pop();
  }
  //# sourceMappingURL=02-6to5-release.js.map

  function Viewmodel$set(keypath, value) {
    var options = arguments[2] === undefined ? {} : arguments[2];
    var mapping, computation, wrapper, keepExistingWrapper;

    // unless data is being set for data tracking purposes
    if (!options.noMapping) {
      // If this data belongs to a different viewmodel,
      // pass the change along
      if (mapping = this.mappings[keypath.firstKey]) {
        return mapping.set(keypath, value);
      }
    }

    computation = this.computations[keypath.str];
    if (computation) {
      if (computation.setting) {
        // let the other computation set() handle things...
        return;
      }
      computation.set(value);
      value = computation.get();
    }

    if (isEqual(this.cache[keypath.str], value)) {
      return;
    }

    wrapper = this.wrapped[keypath.str];

    // If we have a wrapper with a `reset()` method, we try and use it. If the
    // `reset()` method returns false, the wrapper should be torn down, and
    // (most likely) a new one should be created later
    if (wrapper && wrapper.reset) {
      keepExistingWrapper = wrapper.reset(value) !== false;

      if (keepExistingWrapper) {
        value = wrapper.get();
      }
    }

    if (!computation && !keepExistingWrapper) {
      resolveSet(this, keypath, value);
    }

    if (!options.silent) {
      this.mark(keypath);
    } else {
      // We're setting a parent of the original target keypath (i.e.
      // creating a fresh branch) - we need to clear the cache, but
      // not mark it as a change
      this.clearCache(keypath.str);
    }
  }

  function resolveSet(viewmodel, keypath, value) {
    var wrapper, parentValue, wrapperSet, valueSet;

    wrapperSet = function () {
      if (wrapper.set) {
        wrapper.set(keypath.lastKey, value);
      } else {
        parentValue = wrapper.get();
        valueSet();
      }
    };

    valueSet = function () {
      if (!parentValue) {
        parentValue = createBranch(keypath.lastKey);
        viewmodel.set(keypath.parent, parentValue, { silent: true });
      }
      parentValue[keypath.lastKey] = value;
    };

    wrapper = viewmodel.wrapped[keypath.parent.str];

    if (wrapper) {
      wrapperSet();
    } else {
      parentValue = viewmodel.get(keypath.parent);

      // may have been wrapped via the above .get()
      // call on viewmodel if this is first access via .set()!
      if (wrapper = viewmodel.wrapped[keypath.parent.str]) {
        wrapperSet();
      } else {
        valueSet();
      }
    }
  }
  //# sourceMappingURL=02-6to5-set.js.map

  var implicitOption = { implicit: true },
      noCascadeOption = { noCascade: true };

  function Viewmodel$smartUpdate(keypath, array, newIndices) {
    var _this = this;
    var dependants, oldLength, i;

    oldLength = newIndices.length;

    // Indices that are being removed should be marked as dirty
    newIndices.forEach(function (newIndex, oldIndex) {
      if (newIndex === -1) {
        _this.mark(keypath.join(oldIndex), noCascadeOption);
      }
    });

    // Update the model
    // TODO allow existing array to be updated in place, rather than replaced?
    this.set(keypath, array, { silent: true });

    if (dependants = this.deps["default"][keypath.str]) {
      dependants.filter(canShuffle).forEach(function (d) {
        return d.shuffle(newIndices, array);
      });
    }

    if (oldLength !== array.length) {
      this.mark(keypath.join("length"), implicitOption);

      for (i = oldLength; i < array.length; i += 1) {
        this.mark(keypath.join(i));
      }

      // don't allow removed indexes beyond end of new array to trigger recomputations
      // TODO is this still necessary, now that computations are lazy?
      for (i = array.length; i < oldLength; i += 1) {
        this.mark(keypath.join(i), noCascadeOption);
      }
    }
  }

  function canShuffle(dependant) {
    return typeof dependant.shuffle === "function";
  }
  //# sourceMappingURL=02-6to5-smartUpdate.js.map

  function Viewmodel$teardown() {
    var _this = this;
    var unresolvedImplicitDependency;

    // Clear entire cache - this has the desired side-effect
    // of unwrapping adapted values (e.g. arrays)
    Object.keys(this.cache).forEach(function (keypath) {
      return _this.clearCache(keypath);
    });

    // Teardown any failed lookups - we don't need them to resolve any more
    while (unresolvedImplicitDependency = this.unresolvedImplicitDependencies.pop()) {
      unresolvedImplicitDependency.teardown();
    }
  }
  //# sourceMappingURL=02-6to5-teardown.js.map

  function Viewmodel$unregister(keypath, dependant) {
    var group = arguments[2] === undefined ? "default" : arguments[2];
    var mapping, deps, index;

    if (dependant.isStatic) {
      return;
    }

    if (mapping = this.mappings[keypath.firstKey]) {
      return mapping.unregister(keypath, dependant, group);
    }

    deps = this.deps[group][keypath.str];
    index = deps.indexOf(dependant);

    if (index === -1) {
      throw new Error("Attempted to remove a dependant that was no longer registered! This should not happen. If you are seeing this bug in development please raise an issue at https://github.com/RactiveJS/Ractive/issues - thanks");
    }

    deps.splice(index, 1);

    if (keypath.isRoot) {
      return;
    }

    unregister__updateDependantsMap(this, keypath, group);
  }

  function unregister__updateDependantsMap(viewmodel, keypath, group) {
    var map, parent;

    // update dependants map
    while (!keypath.isRoot) {
      map = viewmodel.depsMap[group];
      parent = map[keypath.parent.str];

      parent["_" + keypath.str] -= 1;

      if (!parent["_" + keypath.str]) {
        // remove from parent deps map
        removeFromArray(parent, keypath);
        parent["_" + keypath.str] = undefined;
      }

      keypath = keypath.parent;
    }
  }
  //# sourceMappingURL=02-6to5-unregister.js.map

  var Viewmodel = function (ractive, mappings) {
    var key, mapping;

    this.ractive = ractive; // TODO eventually, we shouldn't need this reference

    // set up explicit mappings
    this.mappings = mappings || create(null);
    for (key in mappings) {
      mappings[key].initViewmodel(this);
    }

    if (ractive.data && ractive.parameters !== true) {
      // if data exists locally, but is missing on the parent,
      // we transfer ownership to the parent
      for (key in ractive.data) {
        if ((mapping = this.mappings[key]) && mapping.getValue() === undefined) {
          mapping.setValue(ractive.data[key]);
        }
      }
    }

    this.cache = {}; // we need to be able to use hasOwnProperty, so can't inherit from null
    this.cacheMap = create(null);

    this.deps = {
      computed: create(null),
      "default": create(null)
    };
    this.depsMap = {
      computed: create(null),
      "default": create(null)
    };

    this.patternObservers = [];

    this.specials = create(null);

    this.wrapped = create(null);
    this.computations = create(null);

    this.captureGroups = [];
    this.unresolvedImplicitDependencies = [];

    this.changes = [];
    this.implicitChanges = {};
    this.noCascade = {};
  };

  Viewmodel.prototype = {
    adapt: Viewmodel$adapt,
    applyChanges: Viewmodel$applyChanges,
    capture: Viewmodel$capture,
    clearCache: Viewmodel$clearCache,
    compute: Viewmodel$compute,
    get: Viewmodel$get,
    init: Viewmodel$init,
    map: Viewmodel$map,
    mark: Viewmodel$mark,
    merge: Viewmodel$merge,
    register: Viewmodel$register,
    release: Viewmodel$release,
    set: Viewmodel$set,
    smartUpdate: Viewmodel$smartUpdate,
    teardown: Viewmodel$teardown,
    unregister: Viewmodel$unregister
  };


  //# sourceMappingURL=02-6to5-Viewmodel.js.map

  function HookQueue(event) {
    this.hook = new Hook(event);
    this.inProcess = {};
    this.queue = {};
  }

  HookQueue.prototype = {

    constructor: HookQueue,

    begin: function (ractive) {
      this.inProcess[ractive._guid] = true;
    },

    end: function (ractive) {
      var parent = ractive.parent;

      // If this is *isn't* a child of a component that's in process,
      // it should call methods or fire at this point
      if (!parent || !this.inProcess[parent._guid]) {
        fire(this, ractive);
      }
      // elsewise, handoff to parent to fire when ready
      else {
        getChildQueue(this.queue, parent).push(ractive);
      }

      delete this.inProcess[ractive._guid];
    }
  };

  function getChildQueue(queue, ractive) {
    return queue[ractive._guid] || (queue[ractive._guid] = []);
  }

  function fire(hookQueue, ractive) {
    var childQueue = getChildQueue(hookQueue.queue, ractive);

    hookQueue.hook.fire(ractive);

    // queue is "live" because components can end up being
    // added while hooks fire on parents that modify data values.
    while (childQueue.length) {
      fire(hookQueue, childQueue.shift());
    }

    delete hookQueue.queue[ractive._guid];
  }



  //# sourceMappingURL=02-6to5-HookQueue.js.map

  var constructHook = new Hook("construct"),
      configHook = new Hook("config"),
      initHook = new HookQueue("init"),
      initialise__uid = 0;

  var initialise = initialiseRactiveInstance;

  function initialiseRactiveInstance(ractive) {
    var userOptions = arguments[1] === undefined ? {} : arguments[1];
    var options = arguments[2] === undefined ? {} : arguments[2];
    var el;

    initialiseProperties(ractive, options);

    // make this option do what would be expected if someone
    // did include it on a new Ractive() or new Component() call.
    // Silly to do so (put a hook on the very options being used),
    // but handle it correctly, consistent with the intent.
    constructHook.fire(config.getConstructTarget(ractive, userOptions), userOptions);

    // init config from Parent and options
    config.init(ractive.constructor, ractive, userOptions);

    // TODO this was moved from Viewmodel.extend - should be
    // rolled in with other config stuff
    if (ractive.magic && !magic) {
      throw new Error("Getters and setters (magic mode) are not supported in this browser");
    }

    configHook.fire(ractive);
    initHook.begin(ractive);

    // TEMPORARY. This is so we can implement Viewmodel gradually
    ractive.viewmodel = new Viewmodel(ractive, options.mappings);

    // hacky circular problem until we get this sorted out
    // if viewmodel immediately processes computed properties,
    // they may call ractive.get, which calls ractive.viewmodel,
    // which hasn't been set till line above finishes.
    ractive.viewmodel.init();

    // Render our *root fragment*
    if (ractive.template) {
      ractive.fragment = new Fragment({
        template: ractive.template,
        root: ractive,
        owner: ractive });
    }

    initHook.end(ractive);

    // render automatically ( if `el` is specified )
    if (el = getElement(ractive.el)) {
      ractive.render(el, ractive.append);
    }
  }

  function initialiseProperties(ractive, options) {
    // Generate a unique identifier, for places where you'd use a weak map if it
    // existed
    ractive._guid = "r-" + initialise__uid++;

    // events
    ractive._subs = create(null);

    // storage for item configuration from instantiation to reset,
    // like dynamic functions or original values
    ractive._config = {};

    // two-way bindings
    ractive._twowayBindings = create(null);

    // animations (so we can stop any in progress at teardown)
    ractive._animations = [];

    // nodes registry
    ractive.nodes = {};

    // live queries
    ractive._liveQueries = [];
    ractive._liveComponentQueries = [];

    // bound data functions
    ractive._boundFunctions = [];


    // properties specific to inline components
    if (options.component) {
      ractive.parent = options.parent;
      ractive.container = options.container || null;
      ractive.root = ractive.parent.root;

      ractive.component = options.component;
      options.component.instance = ractive;

      // for hackability, this could be an open option
      // for any ractive instance, but for now, just
      // for components and just for ractive...
      ractive._inlinePartials = options.inlinePartials;
    } else {
      ractive.root = ractive;
      ractive.parent = ractive.container = null;
    }
  }
  // saves doing `if ( this.parent ) { /*...*/ }` later on
  //# sourceMappingURL=02-6to5-initialise.js.map

  var createInstance = function (component, Component, parameters, yieldTemplate, partials) {
    var instance,
        parentFragment,
        ractive,
        fragment,
        container,
        inlinePartials = {};

    parentFragment = component.parentFragment;
    ractive = component.root;

    partials = partials || {};
    object__extend(inlinePartials, partials || {});

    // Make contents available as a {{>content}} partial
    partials.content = yieldTemplate || [];

    // set a default partial for yields with no name
    inlinePartials[""] = partials.content;

    if (Component.defaults.el) {
      warn("The <%s/> component has a default `el` property; it has been disregarded", component.name);
    }

    // find container
    fragment = parentFragment;
    while (fragment) {
      if (fragment.owner.type === YIELDER) {
        container = fragment.owner.container;
        break;
      }

      fragment = fragment.parent;
    }

    instance = create(Component.prototype);

    initialise(instance, {
      el: null,
      append: true,
      data: parameters.data,
      partials: partials,
      magic: ractive.magic || Component.defaults.magic,
      modifyArrays: ractive.modifyArrays,
      // need to inherit runtime parent adaptors
      adapt: ractive.adapt
    }, {
      parent: ractive,
      component: component,
      container: container,
      mappings: parameters.mappings,
      inlinePartials: inlinePartials
    });

    return instance;
  };
  //# sourceMappingURL=02-6to5-createInstance.js.map

  function ComplexParameter(parameters, key, value) {
    this.parameters = parameters;
    this.parentFragment = parameters.component.parentFragment;
    this.key = key;

    this.fragment = new Fragment({
      template: value,
      root: parameters.component.root,
      owner: this
    });

    this.parameters.addData(this.key.str, this.fragment.getValue());
  }



  ComplexParameter.prototype = {
    bubble: function () {
      if (!this.dirty) {
        this.dirty = true;
        runloop.addView(this);
      }
    },

    update: function () {
      var viewmodel = this.parameters.component.instance.viewmodel;

      this.parameters.addData(this.key.str, this.fragment.getValue());
      viewmodel.mark(this.key);

      this.dirty = false;
    },

    rebind: function (oldKeypath, newKeypath) {
      this.fragment.rebind(oldKeypath, newKeypath);
    },

    unbind: function () {
      this.fragment.unbind();
    }
  };
  //# sourceMappingURL=02-6to5-ComplexParameter.js.map

  function createComponentData(parameters, proto) {
    // Don't do anything with data at all..
    if (!proto.parameters) {
      return parameters.data;
    }
    // No magic or legacy requested
    else if (!magic || proto.parameters === "legacy") {
      return createLegacyData(parameters);
    }
    // ES5 ftw!
    return createDataFromPrototype(parameters, proto);
  }

  function createLegacyData(parameters) {
    var mappings = parameters.mappings,
        key;

    for (key in mappings) {
      var mapping = mappings[key];
      mapping.trackData = true;

      if (!mapping.updatable) {
        parameters.addData(key, mapping.getValue());
      }
    }

    return parameters.data;
  }

  function createDataFromPrototype(parameters, proto) {
    var ComponentData = getConstructor(parameters, proto);
    return new ComponentData(parameters);
  }

  function getConstructor(parameters, proto) {
    var protoparams = proto._parameters;

    if (!protoparams.Constructor || parameters.newKeys.length) {
      protoparams.Constructor = makeConstructor(parameters, protoparams.defined);
    }

    return protoparams.Constructor;
  }

  function makeConstructor(parameters, defined) {
    var ComponentData = function (options) {
      this._mappings = options.mappings;
      this._data = options.data || {};
    };

    var properties, proto;

    properties = parameters.keys.reduce(function (definition, key) {
      definition[key] = {
        get: function () {
          var mapping = this._mappings[key];

          if (mapping) {
            return mapping.getValue();
          } else {
            return this._data[key];
          }
        },
        set: function (value) {
          var mapping = this._mappings[key];

          if (mapping) {
            runloop.start();
            mapping.setValue(value);
            runloop.end();
          } else {
            this._data[key] = value;
          }
        },
        enumerable: true
      };

      return definition;
    }, defined);

    defineProperties(proto = { toJSON: toJSON }, properties);
    proto.constructor = ComponentData;
    ComponentData.prototype = proto;

    return ComponentData;
  }

  var reservedKeys = ["_data", "_mappings"];

  function toJSON() {
    var json = {},
        k;

    for (k in this) {
      if (reservedKeys.indexOf(k) === -1) {
        json[k] = this[k];
      }
    }

    return json;
  }
  //# sourceMappingURL=02-6to5-createComponentData.js.map

  function ParameterResolver(parameters, key, template) {
    var component, resolve, force;

    this.parameters = parameters;
    this.key = key;
    this.resolved = this.ready = false;

    component = parameters.component;
    resolve = this.resolve.bind(this);

    if (template.r) {
      this.resolver = createReferenceResolver(component, template.r, resolve);
    } else if (template.x) {
      this.resolver = new ExpressionResolver(component, component.parentFragment, template.x, resolve);
    } else if (template.rx) {
      this.resolver = new ReferenceExpressionResolver(component, template.rx, resolve);
    }

    if (!this.resolved) {
      // if the resolver can force resolution, so can the mapping
      if (this.resolver && isFunction(this.resolver.forceResolution)) {
        force = this.resolver.forceResolution.bind(this.resolver);
      }

      // note the mapping anyway, for the benefit of child components
      parameters.addMapping(key, undefined, force);
    }

    this.ready = true;
  }



  ParameterResolver.prototype = {
    resolve: function (keypath) {
      this.resolved = true;

      if (this.ready) {
        this.readyResolve(keypath);
      } else {
        this.notReadyResolve(keypath);
      }
    },

    notReadyResolve: function (keypath) {
      if (keypath.isSpecial) {
        this.parameters.addData(this.key.str, keypath.value);
      } else {
        var mapping = this.parameters.addMapping(this.key, keypath);

        if (mapping.getValue() === undefined) {
          mapping.updatable = true;
        }
      }
    },

    readyResolve: function (keypath) {
      var viewmodel = this.parameters.component.instance.viewmodel;

      if (keypath.isSpecial) {
        this.parameters.addData(this.key.str, keypath.value);
        viewmodel.mark(this.key);
      } else if (viewmodel.reversedMappings && viewmodel.reversedMappings[this.key.str]) {
        viewmodel.reversedMappings[this.key.str].rebind(keypath);
      } else {
        viewmodel.mappings[this.key.str].resolve(keypath);
      }
    }
  };
  //# sourceMappingURL=02-6to5-ParameterResolver.js.map

  function createParameters(component, proto, attributes) {
    var parameters, data, defined;

    if (!attributes) {
      return { data: {} };
    }

    if (proto.parameters) {
      defined = getParamsDefinition(proto);
    }

    parameters = new ComponentParameters(component, attributes, defined);
    data = createComponentData(parameters, proto);

    return { data: data, mappings: parameters.mappings };
  }

  function getParamsDefinition(proto) {
    if (!proto._parameters) {
      proto._parameters = { defined: {} };
    } else if (!proto._parameters.defined) {
      proto._parameters.defined = {};
    }
    return proto._parameters.defined;
  }


  function ComponentParameters(component, attributes, defined) {
    var _this = this;
    this.component = component;
    this.parentViewmodel = component.root.viewmodel;
    this.data = {};
    this.mappings = create(null);
    this.newKeys = []; // TODO it's not obvious that this does anything?
    this.keys = Object.keys(attributes);

    this.keys.forEach(function (key) {
      if (defined && !defined[key]) {
        _this.newKeys.push(key);
      }
      _this.add(getKeypath(key), attributes[key]);
    });
  }

  ComponentParameters.prototype = {
    add: function (key, template) {
      // We have static data
      if (typeof template === "string") {
        var parsed = parseJSON(template);
        this.addData(key.str, parsed ? parsed.value : template);
      }
      // Empty string
      // TODO valueless attributes also end up here currently
      // (i.e. `<widget bool>` === `<widget bool=''>`) - this
      // is probably incorrect
      else if (template === 0) {
        this.addData(key.str);
      }
      // Interpolators
      else {
        var resolver = undefined;
        // Single interpolator
        if (isSingleInterpolator(template)) {
          resolver = new ParameterResolver(this, key, template[0]).resolver;
        }
        // We have a 'complex' parameter, e.g.
        // `<widget foo='{{bar}} {{baz}}'/>`
        else {
          resolver = new ComplexParameter(this, key, template);
        }
        this.component.resolvers.push(resolver);
      }
    },

    addData: function (key, value) {
      this.data[key] = value;
    },

    addMapping: function (key, keypath, force) {
      return this.mappings[key.str] = new Mapping(key, {
        origin: this.parentViewmodel,
        keypath: keypath,
        force: force
      });
    }
  };

  function isSingleInterpolator(template) {
    return template.length === 1 && template[0].t === INTERPOLATOR;
  }
  //# sourceMappingURL=02-6to5-createParameters.js.map

  function propagateEvents(component, eventsDescriptor) {
    var eventName;

    for (eventName in eventsDescriptor) {
      if (eventsDescriptor.hasOwnProperty(eventName)) {
        propagateEvent(component.instance, component.root, eventName, eventsDescriptor[eventName]);
      }
    }
  }

  function propagateEvent(childInstance, parentInstance, eventName, proxyEventName) {
    if (typeof proxyEventName !== "string") {
      warn("Components currently only support simple events - you cannot include arguments. Sorry!");
    }

    childInstance.on(eventName, function () {
      var event, args;

      // semi-weak test, but what else? tag the event obj ._isEvent ?
      if (arguments.length && arguments[0] && arguments[0].node) {
        event = Array.prototype.shift.call(arguments);
      }

      args = Array.prototype.slice.call(arguments);

      fireEvent(parentInstance, proxyEventName, { event: event, args: args });

      // cancel bubbling
      return false;
    });
  }
  //# sourceMappingURL=02-6to5-propagateEvents.js.map

  var updateLiveQueries__default = function (component) {
    var ancestor, query;

    // If there's a live query for this component type, add it
    ancestor = component.root;
    while (ancestor) {
      if (query = ancestor._liveComponentQueries["_" + component.name]) {
        query.push(component.instance);
      }

      ancestor = ancestor.parent;
    }
  };
  //# sourceMappingURL=02-6to5-updateLiveQueries.js.map

  function Component$init(options, Component) {
    var parentFragment, root, parameters;

    if (!Component) {
      throw new Error("Component \"" + this.name + "\" not found");
    }

    parentFragment = this.parentFragment = options.parentFragment;
    root = parentFragment.root;

    this.root = root;
    this.type = COMPONENT;
    this.name = options.template.e;
    this.index = options.index;
    this.indexRefBindings = {};
    this.yielders = {};
    this.resolvers = [];

    parameters = createParameters(this, Component.prototype, options.template.a);
    createInstance(this, Component, parameters, options.template.f, options.template.p);
    propagateEvents(this, options.template.v);

    // intro, outro and decorator directives have no effect
    if (options.template.t1 || options.template.t2 || options.template.o) {
      warn("The \"intro\", \"outro\" and \"decorator\" directives have no effect on components");
    }

    updateLiveQueries__default(this);
  }
  //# sourceMappingURL=02-6to5-init.js.map

  function Component$rebind(oldKeypath, newKeypath) {
    var rebind = function (x) {
      x.rebind(oldKeypath, newKeypath);
    };

    var query;

    this.resolvers.forEach(rebind);

    for (var k in this.yielders) {
      if (this.yielders[k][0]) {
        rebind(this.yielders[k][0]);
      }
    }

    if (query = this.root._liveComponentQueries["_" + this.name]) {
      query._makeDirty();
    }
  }
  //# sourceMappingURL=02-6to5-rebind.js.map

  function Component$render() {
    var instance = this.instance;

    instance.render(this.parentFragment.getNode());

    this.rendered = true;
    return instance.fragment.detach();
  }
  //# sourceMappingURL=02-6to5-render.js.map

  function Component$toString() {
    return this.instance.fragment.toString();
  }
  //# sourceMappingURL=02-6to5-toString.js.map

  var Component_prototype_unbind__teardownHook = new Hook("teardown");

  function Component$unbind() {
    var instance = this.instance;

    this.resolvers.forEach(methodCallers__unbind);

    removeFromLiveComponentQueries(this);

    // teardown the instance
    instance.fragment.unbind();
    instance.viewmodel.teardown();

    if (instance.fragment.rendered && instance.el.__ractive_instances__) {
      removeFromArray(instance.el.__ractive_instances__, instance);
    }

    Component_prototype_unbind__teardownHook.fire(instance);
  }

  function removeFromLiveComponentQueries(component) {
    var instance, query;

    instance = component.root;

    do {
      if (query = instance._liveComponentQueries["_" + component.name]) {
        query._remove(component);
      }
    } while (instance = instance.parent);
  }
  //# sourceMappingURL=02-6to5-unbind.js.map

  function Component$unrender(shouldDestroy) {
    this.shouldDestroy = shouldDestroy;
    this.instance.unrender();
  }
  //# sourceMappingURL=02-6to5-unrender.js.map

  var Component = function (options, Constructor) {
    this.init(options, Constructor);
  };

  Component.prototype = {
    detach: Component$detach,
    find: Component$find,
    findAll: Component$findAll,
    findAllComponents: Component$findAllComponents,
    findComponent: Component$findComponent,
    findNextNode: Component$findNextNode,
    firstNode: Component$firstNode,
    init: Component$init,
    rebind: Component$rebind,
    render: Component$render,
    toString: Component$toString,
    unbind: Component$unbind,
    unrender: Component$unrender
  };

  var Component__default = Component;
  //# sourceMappingURL=02-6to5-_Component.js.map

  var Comment = function (options) {
    this.type = COMMENT;
    this.value = options.template.c;
  };

  Comment.prototype = {
    detach: detach__default,

    firstNode: function Comment__firstNode() {
      return this.node;
    },

    render: function Comment__render() {
      if (!this.node) {
        this.node = document.createComment(this.value);
      }

      return this.node;
    },

    toString: function Comment__toString() {
      return "<!--" + this.value + "-->";
    },

    unrender: function Comment__unrender(shouldDestroy) {
      if (shouldDestroy) {
        this.node.parentNode.removeChild(this.node);
      }
    }
  };


  //# sourceMappingURL=02-6to5-Comment.js.map

  var Yielder = function (options) {
    var container, component;

    this.type = YIELDER;

    this.container = container = options.parentFragment.root;
    this.component = component = container.component;

    this.container = container;
    this.containerFragment = options.parentFragment;
    this.parentFragment = component.parentFragment;

    var name = this.name = options.template.n || "";

    this.fragment = new Fragment({
      owner: this,
      root: container.parent,
      template: container._inlinePartials[name] || [],
      pElement: this.containerFragment.pElement
    });

    // even though only one yielder is allowed, we need to have an array of them
    // as it's possible to cause a yielder to be created before the last one
    // was destroyed in the same turn of the runloop
    if (!isArray(component.yielders[name])) {
      component.yielders[name] = [this];
    } else {
      component.yielders[name].push(this);
    }

    runloop.scheduleTask(function () {
      if (component.yielders[name].length > 1) {
        throw new Error("A component template can only have one {{yield" + (name ? " " + name : "") + "}} declaration at a time");
      }
    });
  };

  Yielder.prototype = {
    detach: function Yielder__detach() {
      return this.fragment.detach();
    },

    find: function find(selector) {
      return this.fragment.find(selector);
    },

    findAll: function findAll(selector, query) {
      return this.fragment.findAll(selector, query);
    },

    findComponent: function findComponent(selector) {
      return this.fragment.findComponent(selector);
    },

    findAllComponents: function findAllComponents(selector, query) {
      return this.fragment.findAllComponents(selector, query);
    },

    findNextNode: function findNextNode() {
      return this.containerFragment.findNextNode(this);
    },

    firstNode: function Yielder__firstNode() {
      return this.fragment.firstNode();
    },

    getValue: function Yielder__getValue(options) {
      return this.fragment.getValue(options);
    },

    render: function Yielder__render() {
      return this.fragment.render();
    },

    unbind: function Yielder__unbind() {
      this.fragment.unbind();
    },

    unrender: function Yielder__unrender(shouldDestroy) {
      this.fragment.unrender(shouldDestroy);
      removeFromArray(this.component.yielders[this.name], this);
    },

    rebind: function Yielder__rebind(oldKeypath, newKeypath) {
      this.fragment.rebind(oldKeypath, newKeypath);
    },

    toString: function Yielder__toString() {
      return this.fragment.toString();
    }
  };


  //# sourceMappingURL=02-6to5-Yielder.js.map

  var Doctype = function (options) {
    this.declaration = options.template.a;
  };

  Doctype.prototype = {
    init: noop,
    render: noop,
    unrender: noop,
    teardown: noop,
    toString: function Doctype__toString() {
      return "<!DOCTYPE" + this.declaration + ">";
    }
  };


  //# sourceMappingURL=02-6to5-Doctype.js.map

  function Fragment$init(options) {
    var _this = this;
    this.owner = options.owner; // The item that owns this fragment - an element, section, partial, or attribute
    this.parent = this.owner.parentFragment;

    // inherited properties
    this.root = options.root;
    this.pElement = options.pElement;
    this.context = options.context;
    this.index = options.index;
    this.key = options.key;
    this.registeredIndexRefs = [];

    this.items = options.template.map(function (template, i) {
      return createItem({
        parentFragment: _this,
        pElement: options.pElement,
        template: template,
        index: i
      });
    });

    this.value = this.argsList = null;
    this.dirtyArgs = this.dirtyValue = true;

    this.bound = true;
  }

  function createItem(options) {
    if (typeof options.template === "string") {
      return new Text(options);
    }

    switch (options.template.t) {
      case YIELDER:
        return new Yielder(options);
      case INTERPOLATOR:
        return new Interpolator(options);
      case SECTION:
        return new Section(options);
      case TRIPLE:
        return new Triple(options);
      case ELEMENT:
        var constructor = undefined;
        if (constructor = getComponent__getComponent(options.parentFragment.root, options.template.e)) {
          return new Component__default(options, constructor);
        }
        return new Element(options);
      case PARTIAL:
        return new Partial(options);
      case COMMENT:
        return new Comment(options);
      case DOCTYPE:
        return new Doctype(options);

      default:
        throw new Error("Something very strange happened. Please file an issue at https://github.com/ractivejs/ractive/issues. Thanks!");
    }
  }
  //# sourceMappingURL=02-6to5-init.js.map

  function Fragment$rebind(oldKeypath, newKeypath) {
    // assign new context keypath if needed
    assignNewKeypath(this, "context", oldKeypath, newKeypath);

    this.items.forEach(function (item) {
      if (item.rebind) {
        item.rebind(oldKeypath, newKeypath);
      }
    });
  }
  //# sourceMappingURL=02-6to5-rebind.js.map

  function Fragment$render() {
    var result;

    if (this.items.length === 1) {
      result = this.items[0].render();
    } else {
      result = document.createDocumentFragment();

      this.items.forEach(function (item) {
        result.appendChild(item.render());
      });
    }

    this.rendered = true;
    return result;
  }
  //# sourceMappingURL=02-6to5-render.js.map

  function Fragment$toString(escape) {
    if (!this.items) {
      return "";
    }

    return this.items.map(escape ? toEscapedString : Fragment_prototype_toString__toString).join("");
  }

  function Fragment_prototype_toString__toString(item) {
    return item.toString();
  }

  function toEscapedString(item) {
    return item.toString(true);
  }
  //# sourceMappingURL=02-6to5-toString.js.map

  function Fragment$unbind() {
    if (!this.bound) {
      return;
    }

    this.items.forEach(unbindItem);
    this.bound = false;
  }

  function unbindItem(item) {
    if (item.unbind) {
      item.unbind();
    }
  }
  //# sourceMappingURL=02-6to5-unbind.js.map

  function Fragment$unrender(shouldDestroy) {
    if (!this.rendered) {
      throw new Error("Attempted to unrender a fragment that was not rendered");
    }

    this.items.forEach(function (i) {
      return i.unrender(shouldDestroy);
    });
    this.rendered = false;
  }
  //# sourceMappingURL=02-6to5-unrender.js.map

  var Fragment = function (options) {
    this.init(options);
  };

  Fragment.prototype = {
    bubble: Fragment$bubble,
    detach: Fragment$detach,
    find: Fragment$find,
    findAll: Fragment$findAll,
    findAllComponents: Fragment$findAllComponents,
    findComponent: Fragment$findComponent,
    findNextNode: Fragment$findNextNode,
    firstNode: Fragment$firstNode,
    getArgsList: Fragment$getArgsList,
    getNode: Fragment$getNode,
    getValue: Fragment$getValue,
    init: Fragment$init,
    rebind: Fragment$rebind,
    registerIndexRef: function (idx) {
      var idxs = this.registeredIndexRefs;
      if (idxs.indexOf(idx) === -1) {
        idxs.push(idx);
      }
    },
    render: Fragment$render,
    toString: Fragment$toString,
    unbind: Fragment$unbind,
    unregisterIndexRef: function (idx) {
      var idxs = this.registeredIndexRefs;
      idxs.splice(idxs.indexOf(idx), 1);
    },
    unrender: Fragment$unrender
  };


  //# sourceMappingURL=02-6to5-Fragment.js.map

  var shouldRerender = ["template", "partials", "components", "decorators", "events"],
      resetHook = new Hook("reset");

  function Ractive$reset(data) {
    var promise, wrapper, changes, i, rerender;

    data = data || {};

    if (typeof data !== "object") {
      throw new Error("The reset method takes either no arguments, or an object containing new data");
    }

    // If the root object is wrapped, try and use the wrapper's reset value
    if ((wrapper = this.viewmodel.wrapped[""]) && wrapper.reset) {
      if (wrapper.reset(data) === false) {
        // reset was rejected, we need to replace the object
        this.data = data;
      }
    } else {
      this.data = data;
    }

    // reset config items and track if need to rerender
    changes = config.reset(this);

    i = changes.length;
    while (i--) {
      if (shouldRerender.indexOf(changes[i]) > -1) {
        rerender = true;
        break;
      }
    }

    if (rerender) {
      var component = undefined;

      this.viewmodel.mark(rootKeypath);

      // Is this is a component, we need to set the `shouldDestroy`
      // flag, otherwise it will assume by default that a parent node
      // will be detached, and therefore it doesn't need to bother
      // detaching its own nodes
      if (component = this.component) {
        component.shouldDestroy = true;
      }

      this.unrender();

      if (component) {
        component.shouldDestroy = false;
      }

      // If the template changed, we need to destroy the parallel DOM
      // TODO if we're here, presumably it did?
      if (this.fragment.template !== this.template) {
        this.fragment.unbind();

        this.fragment = new Fragment({
          template: this.template,
          root: this,
          owner: this
        });
      }

      promise = this.render(this.el, this.anchor);
    } else {
      promise = runloop.start(this, true);
      this.viewmodel.mark(rootKeypath);
      runloop.end();
    }

    resetHook.fire(this, data);

    return promise;
  }
  //# sourceMappingURL=02-6to5-reset.js.map

  var resetPartial = function (name, partial) {
    var collect = function (source, dest, ractive) {
      // if this is a component and it has its own partial, bail
      if (ractive && ractive.partials[name]) return;

      source.forEach(function (item) {
        // queue to rerender if the item is a partial and the current name matches
        if (item.type === PARTIAL && item.getPartialName() === name) {
          dest.push(item);
        }

        // if it has a fragment, process its items
        if (item.fragment) {
          collect(item.fragment.items, dest, ractive);
        }

        // or if it has fragments
        if (isArray(item.fragments)) {
          collect(item.fragments, dest, ractive);
        }

        // or if it is itself a fragment, process its items
        else if (isArray(item.items)) {
          collect(item.items, dest, ractive);
        }

        // or if it is a component, step in and process its items
        else if (item.type === COMPONENT && item.instance) {
          collect(item.instance.fragment.items, dest, item.instance);
        }

        // if the item is an element, process its attributes too
        if (item.type === ELEMENT) {
          if (isArray(item.attributes)) {
            collect(item.attributes, dest, ractive);
          }

          if (isArray(item.conditionalAttributes)) {
            collect(item.conditionalAttributes, dest, ractive);
          }
        }
      });
    };

    var promise,
        collection = [];

    collect(this.fragment.items, collection);
    this.partials[name] = partial;

    promise = runloop.start(this, true);

    collection.forEach(function (item) {
      item.value = undefined;
      item.setValue(name);
    });

    runloop.end();

    return promise;
  };
  //# sourceMappingURL=02-6to5-resetPartial.js.map

  function Ractive$resetTemplate(template) {
    var transitionsEnabled, component;

    templateConfigurator.init(null, this, { template: template });

    transitionsEnabled = this.transitionsEnabled;
    this.transitionsEnabled = false;

    // Is this is a component, we need to set the `shouldDestroy`
    // flag, otherwise it will assume by default that a parent node
    // will be detached, and therefore it doesn't need to bother
    // detaching its own nodes
    if (component = this.component) {
      component.shouldDestroy = true;
    }

    this.unrender();

    if (component) {
      component.shouldDestroy = false;
    }

    // remove existing fragment and create new one
    this.fragment.unbind();
    this.fragment = new Fragment({
      template: this.template,
      root: this,
      owner: this
    });

    this.render(this.el, this.anchor);

    this.transitionsEnabled = transitionsEnabled;
  }
  //# sourceMappingURL=02-6to5-resetTemplate.js.map

  var reverse = makeArrayMethod("reverse");
  //# sourceMappingURL=02-6to5-reverse.js.map

  var prototype_set__wildcard = /\*/;

  function Ractive$set(keypath, value) {
    var _this = this;
    var map, promise;

    promise = runloop.start(this, true);

    // Set multiple keypaths in one go
    if (isObject(keypath)) {
      map = keypath;

      for (keypath in map) {
        if (map.hasOwnProperty(keypath)) {
          value = map[keypath];
          keypath = getKeypath(normalise(keypath));

          this.viewmodel.set(keypath, value);
        }
      }
    }

    // Set a single keypath
    else {
      keypath = getKeypath(normalise(keypath));

      // TODO a) wildcard test should probably happen at viewmodel level,
      // b) it should apply to multiple/single set operations
      if (prototype_set__wildcard.test(keypath.str)) {
        getMatchingKeypaths(this, keypath.str).forEach(function (keypath) {
          _this.viewmodel.set(keypath, value);
        });
      } else {
        this.viewmodel.set(keypath, value);
      }
    }

    runloop.end();

    return promise;
  }
  //# sourceMappingURL=02-6to5-set.js.map

  var shift = makeArrayMethod("shift");
  //# sourceMappingURL=02-6to5-shift.js.map

  var prototype_sort = makeArrayMethod("sort");
  //# sourceMappingURL=02-6to5-sort.js.map

  var splice = makeArrayMethod("splice");
  //# sourceMappingURL=02-6to5-splice.js.map

  function Ractive$subtract(keypath, d) {
    return add(this, keypath, d === undefined ? -1 : -d);
  }
  //# sourceMappingURL=02-6to5-subtract.js.map

  var prototype_teardown__teardownHook = new Hook("teardown");

  // Teardown. This goes through the root fragment and all its children, removing observers
  // and generally cleaning up after itself

  function Ractive$teardown() {
    var promise;

    this.fragment.unbind();
    this.viewmodel.teardown();

    if (this.fragment.rendered && this.el.__ractive_instances__) {
      removeFromArray(this.el.__ractive_instances__, this);
    }

    this.shouldDestroy = true;
    promise = this.fragment.rendered ? this.unrender() : utils_Promise.resolve();

    prototype_teardown__teardownHook.fire(this);

    this._boundFunctions.forEach(deleteFunctionCopy);

    return promise;
  }

  function deleteFunctionCopy(bound) {
    delete bound.fn[bound.prop];
  }
  //# sourceMappingURL=02-6to5-teardown.js.map

  function Ractive$toggle(keypath) {
    if (typeof keypath !== "string") {
      throw new TypeError(badArguments);
    }

    return this.set(keypath, !this.get(keypath));
  }
  //# sourceMappingURL=02-6to5-toggle.js.map

  function Ractive$toHTML() {
    return this.fragment.toString(true);
  }
  //# sourceMappingURL=02-6to5-toHTML.js.map

  var unrenderHook = new Hook("unrender");

  function Ractive$unrender() {
    var _this = this;
    var promise, shouldDestroy;

    if (!this.fragment.rendered) {
      warn("ractive.unrender() was called on a Ractive instance that was not rendered");
      return utils_Promise.resolve();
    }

    promise = runloop.start(this, true);

    // If this is a component, and the component isn't marked for destruction,
    // don't detach nodes from the DOM unnecessarily
    shouldDestroy = !this.component || this.component.shouldDestroy || this.shouldDestroy;

    if (this.constructor.css) {
      promise.then(function () {
        css__default.remove(_this.constructor);
      });
    }

    // Cancel any animations in progress
    while (this._animations[0]) {
      this._animations[0].stop(); // it will remove itself from the index
    }

    this.fragment.unrender(shouldDestroy);

    removeFromArray(this.el.__ractive_instances__, this);

    unrenderHook.fire(this);

    runloop.end();
    return promise;
  }
  //# sourceMappingURL=02-6to5-unrender.js.map

  var unshift = makeArrayMethod("unshift");
  //# sourceMappingURL=02-6to5-unshift.js.map

  var updateHook = new Hook("update");

  function Ractive$update(keypath) {
    var promise;

    keypath = getKeypath(keypath) || rootKeypath;

    promise = runloop.start(this, true);
    this.viewmodel.mark(keypath);
    runloop.end();

    updateHook.fire(this, keypath);

    return promise;
  }
  //# sourceMappingURL=02-6to5-update.js.map

  function Ractive$updateModel(keypath, cascade) {
    var values, key, bindings;

    if (typeof keypath === "string" && !cascade) {
      bindings = this._twowayBindings[keypath];
    } else {
      bindings = [];

      for (key in this._twowayBindings) {
        if (!keypath || getKeypath(key).equalsOrStartsWith(keypath)) {
          // TODO is this right?
          bindings.push.apply(bindings, this._twowayBindings[key]);
        }
      }
    }

    values = consolidate(this, bindings);
    return this.set(values);
  }

  function consolidate(ractive, bindings) {
    var values = {},
        checkboxGroups = [];

    bindings.forEach(function (b) {
      var oldValue, newValue;

      // special case - radio name bindings
      if (b.radioName && !b.element.node.checked) {
        return;
      }

      // special case - checkbox name bindings come in groups, so
      // we want to get the value once at most
      if (b.checkboxName) {
        if (!checkboxGroups[b.keypath.str] && !b.changed()) {
          checkboxGroups.push(b.keypath);
          checkboxGroups[b.keypath.str] = b;
        }

        return;
      }

      oldValue = b.attribute.value;
      newValue = b.getValue();

      if (arrayContentsMatch(oldValue, newValue)) {
        return;
      }

      if (!isEqual(oldValue, newValue)) {
        values[b.keypath.str] = newValue;
      }
    });

    // Handle groups of `<input type='checkbox' name='{{foo}}' ...>`
    if (checkboxGroups.length) {
      checkboxGroups.forEach(function (keypath) {
        var binding, oldValue, newValue;

        binding = checkboxGroups[keypath.str]; // one to represent the entire group
        oldValue = binding.attribute.value;
        newValue = binding.getValue();

        if (!arrayContentsMatch(oldValue, newValue)) {
          values[keypath.str] = newValue;
        }
      });
    }

    return values;
  }
  //# sourceMappingURL=02-6to5-updateModel.js.map

  var proto__default = {
    add: Ractive$add,
    animate: Ractive$animate,
    detach: Ractive$detach,
    find: Ractive$find,
    findAll: Ractive$findAll,
    findAllComponents: Ractive$findAllComponents,
    findComponent: Ractive$findComponent,
    findContainer: Ractive$findContainer,
    findParent: Ractive$findParent,
    fire: Ractive$fire,
    get: Ractive$get,
    insert: Ractive$insert,
    merge: Ractive$merge,
    observe: Ractive$observe,
    observeOnce: Ractive$observeOnce,
    off: Ractive$off,
    on: Ractive$on,
    once: Ractive$once,
    pop: pop,
    push: push,
    render: Ractive$render,
    reset: Ractive$reset,
    resetPartial: resetPartial,
    resetTemplate: Ractive$resetTemplate,
    reverse: reverse,
    set: Ractive$set,
    shift: shift,
    sort: prototype_sort,
    splice: splice,
    subtract: Ractive$subtract,
    teardown: Ractive$teardown,
    toggle: Ractive$toggle,
    toHTML: Ractive$toHTML,
    toHtml: Ractive$toHTML,
    unrender: Ractive$unrender,
    unshift: unshift,
    update: Ractive$update,
    updateModel: Ractive$updateModel
  };
  //# sourceMappingURL=02-6to5-prototype.js.map

  function unwrap(Child) {
    var options = {};

    while (Child) {
      addRegistries(Child, options);
      addOtherOptions(Child, options);

      if (Child._Parent !== Ractive) {
        Child = Child._Parent;
      } else {
        Child = false;
      }
    }

    return options;
  }

  function addRegistries(Child, options) {
    registries.forEach(function (r) {
      addRegistry(r.useDefaults ? Child.prototype : Child, options, r.name);
    });
  }

  function addRegistry(target, options, name) {
    var registry,
        keys = Object.keys(target[name]);

    if (!keys.length) {
      return;
    }

    if (!(registry = options[name])) {
      registry = options[name] = {};
    }

    keys.filter(function (key) {
      return !(key in registry);
    }).forEach(function (key) {
      return registry[key] = target[name][key];
    });
  }

  function addOtherOptions(Child, options) {
    Object.keys(Child.prototype).forEach(function (key) {
      if (key === "computed") {
        return;
      }

      var value = Child.prototype[key];

      if (!(key in options)) {
        options[key] = value._method ? value._method : value;
      }

      // is it a wrapped function?
      else if (typeof options[key] === "function" && typeof value === "function" && options[key]._method) {
        var result = undefined,
            needsSuper = value._method;

        if (needsSuper) {
          value = value._method;
        }

        // rewrap bound directly to parent fn
        result = wrap__default(options[key]._method, value);

        if (needsSuper) {
          result._method = result;
        }

        options[key] = result;
      }
    });
  }
  //# sourceMappingURL=02-6to5-unwrapExtended.js.map

  var extend__uid = 1;

  function extend__extend() {
    var options = arguments[0] === undefined ? {} : arguments[0];
    var Parent = this,
        Child,
        proto;

    // if we're extending with another Ractive instance...
    //
    //   var Human = Ractive.extend(...), Spider = Ractive.extend(...);
    //   var Spiderman = Human.extend( Spider );
    //
    // ...inherit prototype methods and default options as well
    if (options.prototype instanceof Ractive) {
      options = unwrap(options);
    }

    Child = function (options) {
      initialise(this, options);
    };

    proto = create(Parent.prototype);
    proto.constructor = Child;

    // Static properties
    defineProperties(Child, {
      // each component needs a unique ID, for managing CSS
      _guid: { value: extend__uid++ },

      // alias prototype as defaults
      defaults: { value: proto },

      // extendable
      extend: { value: extend__extend, writable: true, configurable: true },

      // Parent - for IE8, can't use Object.getPrototypeOf
      _Parent: { value: Parent }
    });

    // extend configuration
    config.extend(Parent, proto, options);

    Child.prototype = proto;

    return Child;
  }
  //# sourceMappingURL=02-6to5-_extend.js.map

  var getNodeInfo = function (node) {
    var info = {},
        priv,
        indices;

    if (!node || !(priv = node._ractive)) {
      return info;
    }

    info.ractive = priv.root;
    info.keypath = priv.keypath.str;
    info.index = {};

    // find all index references and resolve them
    if (indices = findIndexRefs(priv.proxy.parentFragment)) {
      info.index = findIndexRefs.resolve(indices);
    }

    return info;
  };
  //# sourceMappingURL=02-6to5-getNodeInfo.js.map

  var Ractive, properties;

  // Main Ractive required object
  Ractive = function (options) {
    initialise(this, options);
  };


  // Ractive properties
  properties = {

    // static methods:
    extend: { value: extend__extend },
    getNodeInfo: { value: getNodeInfo },
    parse: { value: parse },

    // Namespaced constructors
    Promise: { value: utils_Promise },

    // support
    svg: { value: svg },
    magic: { value: magic },

    // version
    VERSION: { value: "0.7.0-edge" },

    // Plugins
    adaptors: { writable: true, value: {} },
    components: { writable: true, value: {} },
    decorators: { writable: true, value: {} },
    easing: { writable: true, value: easing__default },
    events: { writable: true, value: {} },
    interpolators: { writable: true, value: interpolators },
    partials: { writable: true, value: {} },
    transitions: { writable: true, value: {} }
  };


  // Ractive properties
  defineProperties(Ractive, properties);

  Ractive.prototype = object__extend(proto__default, defaults);

  Ractive.prototype.constructor = Ractive;

  // alias prototype as defaults
  Ractive.defaults = Ractive.prototype;

  // Ractive.js makes liberal use of things like Array.prototype.indexOf. In
  // older browsers, these are made available via a shim - here, we do a quick
  // pre-flight check to make sure that either a) we're not in a shit browser,
  // or b) we're using a Ractive-legacy.js build
  var FUNCTION = "function";

  if (typeof Date.now !== FUNCTION || typeof String.prototype.trim !== FUNCTION || typeof Object.keys !== FUNCTION || typeof Array.prototype.indexOf !== FUNCTION || typeof Array.prototype.forEach !== FUNCTION || typeof Array.prototype.map !== FUNCTION || typeof Array.prototype.filter !== FUNCTION || typeof window !== "undefined" && typeof window.addEventListener !== FUNCTION) {
    throw new Error("It looks like you're attempting to use Ractive.js in an older browser. You'll need to use one of the 'legacy builds' in order to continue - see http://docs.ractivejs.org/latest/legacy-builds for more information.");
  }


  //# sourceMappingURL=02-6to5-Ractive.js.map

  return Ractive;

}));
//# sourceMappingURL=ractive-legacy.js.map