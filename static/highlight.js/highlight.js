/*
  Highlight.js 10.3.2 (31e1fc40)
  License: BSD-3-Clause
  Copyright (c) 2006-2020, Ivan Sagalaev
*/
var hljs = (function () {
  'use strict';

  // https://github.com/substack/deep-freeze/blob/master/index.js
  
  function deepFreeze(obj) {
    Object.freeze(obj);

    var objIsFunction = typeof obj === 'function';

    Object.getOwnPropertyNames(obj).forEach(function(prop) {
      if (Object.hasOwnProperty.call(obj, prop)
      && obj[prop] !== null
      && (typeof obj[prop] === "object" || typeof obj[prop] === "function")
      // IE11 fix: https://github.com/highlightjs/highlight.js/issues/2318
      // TODO: remove in the future
      && (objIsFunction ? prop !== 'caller' && prop !== 'callee' && prop !== 'arguments' : true)
      && !Object.isFrozen(obj[prop])) {
        deepFreeze(obj[prop]);
      }
    });

    return obj;
  }

  class Response {
    /**
     * @param {CompiledMode} mode
     */
    constructor(mode) {
      // eslint-disable-next-line no-undefined
      if (mode.data === undefined) mode.data = {};

      this.data = mode.data;
    }

    ignoreMatch() {
      this.ignore = true;
    }
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function escapeHTML(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * performs a shallow merge of multiple objects into one
   *
   * @template T
   * @param {T} original
   * @param {Record<string,any>[]} objects
   * @returns {T} a single new object
   */
  function inherit(original, ...objects) {
    /** @type Record<string,any> */
    var result = {};

    for (const key in original) {
      result[key] = original[key];
    }
    objects.forEach(function(obj) {
      for (const key in obj) {
        result[key] = obj[key];
      }
    });
    return /** @type {T} */ (result);
  }

  /* Stream merging */

  /**
   * @typedef Event
   * @property {'start'|'stop'} event
   * @property {number} offset
   * @property {Node} node
   */

  /**
   * @param {Node} node
   */
  function tag(node) {
    return node.nodeName.toLowerCase();
  }

  /**
   * @param {Node} node
   */
  function nodeStream(node) {
    /** @type Event[] */
    var result = [];
    (function _nodeStream(node, offset) {
      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          offset += child.nodeValue.length;
        } else if (child.nodeType === 1) {
          result.push({
            event: 'start',
            offset: offset,
            node: child
          });
          offset = _nodeStream(child, offset);
          // Prevent void elements from having an end tag that would actually
          // double them in the output. There are more void elements in HTML
          // but we list only those realistically expected in code display.
          if (!tag(child).match(/br|hr|img|input/)) {
            result.push({
              event: 'stop',
              offset: offset,
              node: child
            });
          }
        }
      }
      return offset;
    })(node, 0);
    return result;
  }

  /**
   * @param {any} original - the original stream
   * @param {any} highlighted - stream of the highlighted source
   * @param {string} value - the original source itself
   */
  function mergeStreams(original, highlighted, value) {
    var processed = 0;
    var result = '';
    var nodeStack = [];

    function selectStream() {
      if (!original.length || !highlighted.length) {
        return original.length ? original : highlighted;
      }
      if (original[0].offset !== highlighted[0].offset) {
        return (original[0].offset < highlighted[0].offset) ? original : highlighted;
      }

      /*
      To avoid starting the stream just before it should stop the order is
      ensured that original always starts first and closes last:

      if (event1 == 'start' && event2 == 'start')
        return original;
      if (event1 == 'start' && event2 == 'stop')
        return highlighted;
      if (event1 == 'stop' && event2 == 'start')
        return original;
      if (event1 == 'stop' && event2 == 'stop')
        return highlighted;

      ... which is collapsed to:
      */
      return highlighted[0].event === 'start' ? original : highlighted;
    }

    /**
     * @param {Node} node
     */
    function open(node) {
      /** @param {Attr} attr */
      function attributeString(attr) {
        return ' ' + attr.nodeName + '="' + escapeHTML(attr.value) + '"';
      }
      // @ts-ignore
      result += '<' + tag(node) + [].map.call(node.attributes, attributeString).join('') + '>';
    }

    /**
     * @param {Node} node
     */
    function close(node) {
      result += '</' + tag(node) + '>';
    }

    /**
     * @param {Event} event
     */
    function render(event) {
      (event.event === 'start' ? open : close)(event.node);
    }

    while (original.length || highlighted.length) {
      var stream = selectStream();
      result += escapeHTML(value.substring(processed, stream[0].offset));
      processed = stream[0].offset;
      if (stream === original) {
        /*
        On any opening or closing tag of the original markup we first close
        the entire highlighted node stack, then render the original tag along
        with all the following original tags at the same offset and then
        reopen all the tags on the highlighted stack.
        */
        nodeStack.reverse().forEach(close);
        do {
          render(stream.splice(0, 1)[0]);
          stream = selectStream();
        } while (stream === original && stream.length && stream[0].offset === processed);
        nodeStack.reverse().forEach(open);
      } else {
        if (stream[0].event === 'start') {
          nodeStack.push(stream[0].node);
        } else {
          nodeStack.pop();
        }
        render(stream.splice(0, 1)[0]);
      }
    }
    return result + escapeHTML(value.substr(processed));
  }

  var utils = /*#__PURE__*/Object.freeze({
    __proto__: null,
    escapeHTML: escapeHTML,
    inherit: inherit,
    nodeStream: nodeStream,
    mergeStreams: mergeStreams
  });

  /**
   * @typedef {object} Renderer
   * @property {(text: string) => void} addText
   * @property {(node: Node) => void} openNode
   * @property {(node: Node) => void} closeNode
   * @property {() => string} value
   */

  /** @typedef {{kind?: string, sublanguage?: boolean}} Node */
  /** @typedef {{walk: (r: Renderer) => void}} Tree */
  /** */

  const SPAN_CLOSE = '</span>';

  /**
   * Determines if a node needs to be wrapped in <span>
   *
   * @param {Node} node */
  const emitsWrappingTags = (node) => {
    return !!node.kind;
  };

  /** @type {Renderer} */
  class HTMLRenderer {
    /**
     * Creates a new HTMLRenderer
     *
     * @param {Tree} parseTree - the parse tree (must support `walk` API)
     * @param {{classPrefix: string}} options
     */
    constructor(parseTree, options) {
      this.buffer = "";
      this.classPrefix = options.classPrefix;
      parseTree.walk(this);
    }

    /**
     * Adds texts to the output stream
     *
     * @param {string} text */
    addText(text) {
      this.buffer += escapeHTML(text);
    }

    /**
     * Adds a node open to the output stream (if needed)
     *
     * @param {Node} node */
    openNode(node) {
      if (!emitsWrappingTags(node)) return;

      let className = node.kind;
      if (!node.sublanguage) {
        className = `${this.classPrefix}${className}`;
      }
      this.span(className);
    }

    /**
     * Adds a node close to the output stream (if needed)
     *
     * @param {Node} node */
    closeNode(node) {
      if (!emitsWrappingTags(node)) return;

      this.buffer += SPAN_CLOSE;
    }

    /**
     * returns the accumulated buffer
    */
    value() {
      return this.buffer;
    }

    // helpers

    /**
     * Builds a span element
     *
     * @param {string} className */
    span(className) {
      this.buffer += `<span class="${className}">`;
    }
  }

  /** @typedef {{kind?: string, sublanguage?: boolean, children: Node[]} | string} Node */
  /** @typedef {{kind?: string, sublanguage?: boolean, children: Node[]} } DataNode */
  /**  */

  class TokenTree {
    constructor() {
      /** @type DataNode */
      this.rootNode = { children: [] };
      this.stack = [this.rootNode];
    }

    get top() {
      return this.stack[this.stack.length - 1];
    }

    get root() { return this.rootNode; }

    /** @param {Node} node */
    add(node) {
      this.top.children.push(node);
    }

    /** @param {string} kind */
    openNode(kind) {
      /** @type Node */
      const node = { kind, children: [] };
      this.add(node);
      this.stack.push(node);
    }

    closeNode() {
      if (this.stack.length > 1) {
        return this.stack.pop();
      }
      // eslint-disable-next-line no-undefined
      return undefined;
    }

    closeAllNodes() {
      while (this.closeNode());
    }

    toJSON() {
      return JSON.stringify(this.rootNode, null, 4);
    }

    /**
     * @typedef { import("./html_renderer").Renderer } Renderer
     * @param {Renderer} builder
     */
    walk(builder) {
      // this does not
      return this.constructor._walk(builder, this.rootNode);
      // this works
      // return TokenTree._walk(builder, this.rootNode);
    }

    /**
     * @param {Renderer} builder
     * @param {Node} node
     */
    static _walk(builder, node) {
      if (typeof node === "string") {
        builder.addText(node);
      } else if (node.children) {
        builder.openNode(node);
        node.children.forEach((child) => this._walk(builder, child));
        builder.closeNode(node);
      }
      return builder;
    }

    /**
     * @param {Node} node
     */
    static _collapse(node) {
      if (typeof node === "string") return;
      if (!node.children) return;

      if (node.children.every(el => typeof el === "string")) {
        // node.text = node.children.join("");
        // delete node.children;
        node.children = [node.children.join("")];
      } else {
        node.children.forEach((child) => {
          TokenTree._collapse(child);
        });
      }
    }
  }

  /**
    Currently this is all private API, but this is the minimal API necessary
    that an Emitter must implement to fully support the parser.

    Minimal interface:

    - addKeyword(text, kind)
    - addText(text)
    - addSublanguage(emitter, subLanguageName)
    - finalize()
    - openNode(kind)
    - closeNode()
    - closeAllNodes()
    - toHTML()

  */

  /**
   * @implements {Emitter}
   */
  class TokenTreeEmitter extends TokenTree {
    /**
     * @param {*} options
     */
    constructor(options) {
      super();
      this.options = options;
    }

    /**
     * @param {string} text
     * @param {string} kind
     */
    addKeyword(text, kind) {
      if (text === "") { return; }

      this.openNode(kind);
      this.addText(text);
      this.closeNode();
    }

    /**
     * @param {string} text
     */
    addText(text) {
      if (text === "") { return; }

      this.add(text);
    }

    /**
     * @param {Emitter & {root: DataNode}} emitter
     * @param {string} name
     */
    addSublanguage(emitter, name) {
      /** @type DataNode */
      const node = emitter.root;
      node.kind = name;
      node.sublanguage = true;
      this.add(node);
    }

    toHTML() {
      const renderer = new HTMLRenderer(this, this.options);
      return renderer.value();
    }

    finalize() {
      return true;
    }
  }

  /**
   * @param {string} value
   * @returns {RegExp}
   * */
  function escape(value) {
    return new RegExp(value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'm');
  }

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function source(re) {
    if (!re) return null;
    if (typeof re === "string") return re;

    return re.source;
  }

  /**
   * @param {...(RegExp | string) } args
   * @returns {string}
   */
  function concat(...args) {
    const joined = args.map((x) => source(x)).join("");
    return joined;
  }

  /**
   * @param {RegExp} re
   * @returns {number}
   */
  function countMatchGroups(re) {
    return (new RegExp(re.toString() + '|')).exec('').length - 1;
  }

  /**
   * Does lexeme start with a regular expression match at the beginning
   * @param {RegExp} re
   * @param {string} lexeme
   */
  function startsWith(re, lexeme) {
    var match = re && re.exec(lexeme);
    return match && match.index === 0;
  }

  // join logically computes regexps.join(separator), but fixes the
  // backreferences so they continue to match.
  // it also places each individual regular expression into it's own
  // match group, keeping track of the sequencing of those match groups
  // is currently an exercise for the caller. :-)
  /**
   * @param {(string | RegExp)[]} regexps
   * @param {string} separator
   * @returns {string}
   */
  function join(regexps, separator = "|") {
    // backreferenceRe matches an open parenthesis or backreference. To avoid
    // an incorrect parse, it additionally matches the following:
    // - [...] elements, where the meaning of parentheses and escapes change
    // - other escape sequences, so we do not misparse escape sequences as
    //   interesting elements
    // - non-matching or lookahead parentheses, which do not capture. These
    //   follow the '(' with a '?'.
    var backreferenceRe = /\[(?:[^\\\]]|\\.)*\]|\(\??|\\([1-9][0-9]*)|\\./;
    var numCaptures = 0;
    var ret = '';
    for (var i = 0; i < regexps.length; i++) {
      numCaptures += 1;
      var offset = numCaptures;
      var re = source(regexps[i]);
      if (i > 0) {
        ret += separator;
      }
      ret += "(";
      while (re.length > 0) {
        var match = backreferenceRe.exec(re);
        if (match == null) {
          ret += re;
          break;
        }
        ret += re.substring(0, match.index);
        re = re.substring(match.index + match[0].length);
        if (match[0][0] === '\\' && match[1]) {
          // Adjust the backreference.
          ret += '\\' + String(Number(match[1]) + offset);
        } else {
          ret += match[0];
          if (match[0] === '(') {
            numCaptures++;
          }
        }
      }
      ret += ")";
    }
    return ret;
  }

  // Common regexps
  const IDENT_RE = '[a-zA-Z]\\w*';
  const UNDERSCORE_IDENT_RE = '[a-zA-Z_]\\w*';
  const NUMBER_RE = '\\b\\d+(\\.\\d+)?';
  const C_NUMBER_RE = '(-?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)'; // 0x..., 0..., decimal, float
  const BINARY_NUMBER_RE = '\\b(0b[01]+)'; // 0b...
  const RE_STARTERS_RE = '!|!=|!==|%|%=|&|&&|&=|\\*|\\*=|\\+|\\+=|,|-|-=|/=|/|:|;|<<|<<=|<=|<|===|==|=|>>>=|>>=|>=|>>>|>>|>|\\?|\\[|\\{|\\(|\\^|\\^=|\\||\\|=|\\|\\||~';

  /**
  * @param { Partial<Mode> & {binary?: string | RegExp} } opts
  */
  const SHEBANG = (opts = {}) => {
    const beginShebang = /^#![ ]*\//;
    if (opts.binary) {
      opts.begin = concat(
        beginShebang,
        /.*\b/,
        opts.binary,
        /\b.*/);
    }
    return inherit({
      className: 'meta',
      begin: beginShebang,
      end: /$/,
      relevance: 0,
      /** @type {ModeCallback} */
      "on:begin": (m, resp) => {
        if (m.index !== 0) resp.ignoreMatch();
      }
    }, opts);
  };

  // Common modes
  const BACKSLASH_ESCAPE = {
    begin: '\\\\[\\s\\S]', relevance: 0
  };
  const APOS_STRING_MODE = {
    className: 'string',
    begin: '\'',
    end: '\'',
    illegal: '\\n',
    contains: [BACKSLASH_ESCAPE]
  };
  const QUOTE_STRING_MODE = {
    className: 'string',
    begin: '"',
    end: '"',
    illegal: '\\n',
    contains: [BACKSLASH_ESCAPE]
  };
  const PHRASAL_WORDS_MODE = {
    begin: /\b(a|an|the|are|I'm|isn't|don't|doesn't|won't|but|just|should|pretty|simply|enough|gonna|going|wtf|so|such|will|you|your|they|like|more)\b/
  };
  /**
   * Creates a comment mode
   *
   * @param {string | RegExp} begin
   * @param {string | RegExp} end
   * @param {Mode | {}} [modeOptions]
   * @returns {Partial<Mode>}
   */
  const COMMENT = function(begin, end, modeOptions = {}) {
    var mode = inherit(
      {
        className: 'comment',
        begin,
        end,
        contains: []
      },
      modeOptions
    );
    mode.contains.push(PHRASAL_WORDS_MODE);
    mode.contains.push({
      className: 'doctag',
      begin: '(?:TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):',
      relevance: 0
    });
    return mode;
  };
  const C_LINE_COMMENT_MODE = COMMENT('//', '$');
  const C_BLOCK_COMMENT_MODE = COMMENT('/\\*', '\\*/');
  const HASH_COMMENT_MODE = COMMENT('#', '$');
  const NUMBER_MODE = {
    className: 'number',
    begin: NUMBER_RE,
    relevance: 0
  };
  const C_NUMBER_MODE = {
    className: 'number',
    begin: C_NUMBER_RE,
    relevance: 0
  };
  const BINARY_NUMBER_MODE = {
    className: 'number',
    begin: BINARY_NUMBER_RE,
    relevance: 0
  };
  const CSS_NUMBER_MODE = {
    className: 'number',
    begin: NUMBER_RE + '(' +
      '%|em|ex|ch|rem' +
      '|vw|vh|vmin|vmax' +
      '|cm|mm|in|pt|pc|px' +
      '|deg|grad|rad|turn' +
      '|s|ms' +
      '|Hz|kHz' +
      '|dpi|dpcm|dppx' +
      ')?',
    relevance: 0
  };
  const REGEXP_MODE = {
    // this outer rule makes sure we actually have a WHOLE regex and not simply
    // an expression such as:
    //
    //     3 / something
    //
    // (which will then blow up when regex's `illegal` sees the newline)
    begin: /(?=\/[^/\n]*\/)/,
    contains: [{
      className: 'regexp',
      begin: /\//,
      end: /\/[gimuy]*/,
      illegal: /\n/,
      contains: [
        BACKSLASH_ESCAPE,
        {
          begin: /\[/,
          end: /\]/,
          relevance: 0,
          contains: [BACKSLASH_ESCAPE]
        }
      ]
    }]
  };
  const TITLE_MODE = {
    className: 'title',
    begin: IDENT_RE,
    relevance: 0
  };
  const UNDERSCORE_TITLE_MODE = {
    className: 'title',
    begin: UNDERSCORE_IDENT_RE,
    relevance: 0
  };
  const METHOD_GUARD = {
    // excludes method names from keyword processing
    begin: '\\.\\s*' + UNDERSCORE_IDENT_RE,
    relevance: 0
  };

  /**
   * Adds end same as begin mechanics to a mode
   *
   * Your mode must include at least a single () match group as that first match
   * group is what is used for comparison
   * @param {Partial<Mode>} mode
   */
  const END_SAME_AS_BEGIN = function(mode) {
    return Object.assign(mode,
      {
        /** @type {ModeCallback} */
        'on:begin': (m, resp) => { resp.data._beginMatch = m[1]; },
        /** @type {ModeCallback} */
        'on:end': (m, resp) => { if (resp.data._beginMatch !== m[1]) resp.ignoreMatch(); }
      });
  };

  var MODES = /*#__PURE__*/Object.freeze({
    __proto__: null,
    IDENT_RE: IDENT_RE,
    UNDERSCORE_IDENT_RE: UNDERSCORE_IDENT_RE,
    NUMBER_RE: NUMBER_RE,
    C_NUMBER_RE: C_NUMBER_RE,
    BINARY_NUMBER_RE: BINARY_NUMBER_RE,
    RE_STARTERS_RE: RE_STARTERS_RE,
    SHEBANG: SHEBANG,
    BACKSLASH_ESCAPE: BACKSLASH_ESCAPE,
    APOS_STRING_MODE: APOS_STRING_MODE,
    QUOTE_STRING_MODE: QUOTE_STRING_MODE,
    PHRASAL_WORDS_MODE: PHRASAL_WORDS_MODE,
    COMMENT: COMMENT,
    C_LINE_COMMENT_MODE: C_LINE_COMMENT_MODE,
    C_BLOCK_COMMENT_MODE: C_BLOCK_COMMENT_MODE,
    HASH_COMMENT_MODE: HASH_COMMENT_MODE,
    NUMBER_MODE: NUMBER_MODE,
    C_NUMBER_MODE: C_NUMBER_MODE,
    BINARY_NUMBER_MODE: BINARY_NUMBER_MODE,
    CSS_NUMBER_MODE: CSS_NUMBER_MODE,
    REGEXP_MODE: REGEXP_MODE,
    TITLE_MODE: TITLE_MODE,
    UNDERSCORE_TITLE_MODE: UNDERSCORE_TITLE_MODE,
    METHOD_GUARD: METHOD_GUARD,
    END_SAME_AS_BEGIN: END_SAME_AS_BEGIN
  });

  // keywords that should have no default relevance value
  var COMMON_KEYWORDS = 'of and for in not or if then'.split(' ');

  // compilation

  /**
   * Compiles a language definition result
   *
   * Given the raw result of a language definition (Language), compiles this so
   * that it is ready for highlighting code.
   * @param {Language} language
   * @returns {CompiledLanguage}
   */
  function compileLanguage(language) {
    /**
     * Builds a regex with the case sensativility of the current language
     *
     * @param {RegExp | string} value
     * @param {boolean} [global]
     */
    function langRe(value, global) {
      return new RegExp(
        source(value),
        'm' + (language.case_insensitive ? 'i' : '') + (global ? 'g' : '')
      );
    }

    /**
      Stores multiple regular expressions and allows you to quickly search for
      them all in a string simultaneously - returning the first match.  It does
      this by creating a huge (a|b|c) regex - each individual item wrapped with ()
      and joined by `|` - using match groups to track position.  When a match is
      found checking which position in the array has content allows us to figure
      out which of the original regexes / match groups triggered the match.

      The match object itself (the result of `Regex.exec`) is returned but also
      enhanced by merging in any meta-data that was registered with the regex.
      This is how we keep track of which mode matched, and what type of rule
      (`illegal`, `begin`, end, etc).
    */
    class MultiRegex {
      constructor() {
        this.matchIndexes = {};
        // @ts-ignore
        this.regexes = [];
        this.matchAt = 1;
        this.position = 0;
      }

      // @ts-ignore
      addRule(re, opts) {
        opts.position = this.position++;
        // @ts-ignore
        this.matchIndexes[this.matchAt] = opts;
        this.regexes.push([opts, re]);
        this.matchAt += countMatchGroups(re) + 1;
      }

      compile() {
        if (this.regexes.length === 0) {
          // avoids the need to check length every time exec is called
          // @ts-ignore
          this.exec = () => null;
        }
        const terminators = this.regexes.map(el => el[1]);
        this.matcherRe = langRe(join(terminators), true);
        this.lastIndex = 0;
      }

      /** @param {string} s */
      exec(s) {
        this.matcherRe.lastIndex = this.lastIndex;
        const match = this.matcherRe.exec(s);
        if (!match) { return null; }

        // eslint-disable-next-line no-undefined
        const i = match.findIndex((el, i) => i > 0 && el !== undefined);
        // @ts-ignore
        const matchData = this.matchIndexes[i];
        // trim off any earlier non-relevant match groups (ie, the other regex
        // match groups that make up the multi-matcher)
        match.splice(0, i);

        return Object.assign(match, matchData);
      }
    }

    /*
      Created to solve the key deficiently with MultiRegex - there is no way to
      test for multiple matches at a single location.  Why would we need to do
      that?  In the future a more dynamic engine will allow certain matches to be
      ignored.  An example: if we matched say the 3rd regex in a large group but
      decided to ignore it - we'd need to started testing again at the 4th
      regex... but MultiRegex itself gives us no real way to do that.

      So what this class creates MultiRegexs on the fly for whatever search
      position they are needed.

      NOTE: These additional MultiRegex objects are created dynamically.  For most
      grammars most of the time we will never actually need anything more than the
      first MultiRegex - so this shouldn't have too much overhead.

      Say this is our search group, and we match regex3, but wish to ignore it.

        regex1 | regex2 | regex3 | regex4 | regex5    ' ie, startAt = 0

      What we need is a new MultiRegex that only includes the remaining
      possibilities:

        regex4 | regex5                               ' ie, startAt = 3

      This class wraps all that complexity up in a simple API... `startAt` decides
      where in the array of expressions to start doing the matching. It
      auto-increments, so if a match is found at position 2, then startAt will be
      set to 3.  If the end is reached startAt will return to 0.

      MOST of the time the parser will be setting startAt manually to 0.
    */
    class ResumableMultiRegex {
      constructor() {
        // @ts-ignore
        this.rules = [];
        // @ts-ignore
        this.multiRegexes = [];
        this.count = 0;

        this.lastIndex = 0;
        this.regexIndex = 0;
      }

      // @ts-ignore
      getMatcher(index) {
        if (this.multiRegexes[index]) return this.multiRegexes[index];

        const matcher = new MultiRegex();
        this.rules.slice(index).forEach(([re, opts]) => matcher.addRule(re, opts));
        matcher.compile();
        this.multiRegexes[index] = matcher;
        return matcher;
      }

      resumingScanAtSamePosition() {
        return this.regexIndex !== 0;
      }

      considerAll() {
        this.regexIndex = 0;
      }

      // @ts-ignore
      addRule(re, opts) {
        this.rules.push([re, opts]);
        if (opts.type === "begin") this.count++;
      }

      /** @param {string} s */
      exec(s) {
        const m = this.getMatcher(this.regexIndex);
        m.lastIndex = this.lastIndex;
        let result = m.exec(s);

        // The following is because we have no easy way to say "resume scanning at the
        // existing position but also skip the current rule ONLY". What happens is
        // all prior rules are also skipped which can result in matching the wrong
        // thing. Example of matching "booger":

        // our matcher is [string, "booger", number]
        //
        // ....booger....

        // if "booger" is ignored then we'd really need a regex to scan from the
        // SAME position for only: [string, number] but ignoring "booger" (if it
        // was the first match), a simple resume would scan ahead who knows how
        // far looking only for "number", ignoring potential string matches (or
        // future "booger" matches that might be valid.)

        // So what we do: We execute two matchers, one resuming at the same
        // position, but the second full matcher starting at the position after:

        //     /--- resume first regex match here (for [number])
        //     |/---- full match here for [string, "booger", number]
        //     vv
        // ....booger....

        // Which ever results in a match first is then used. So this 3-4 step
        // process essentially allows us to say "match at this position, excluding
        // a prior rule that was ignored".
        //
        // 1. Match "booger" first, ignore. Also proves that [string] does non match.
        // 2. Resume matching for [number]
        // 3. Match at index + 1 for [string, "booger", number]
        // 4. If #2 and #3 result in matches, which came first?
        if (this.resumingScanAtSamePosition()) {
          if (result && result.index === this.lastIndex) ; else { // use the second matcher result
            const m2 = this.getMatcher(0);
            m2.lastIndex = this.lastIndex + 1;
            result = m2.exec(s);
          }
        }

        if (result) {
          this.regexIndex += result.position + 1;
          if (this.regexIndex === this.count) {
            // wrap-around to considering all matches again
            this.considerAll();
          }
        }

        return result;
      }
    }

    /**
     * Given a mode, builds a huge ResumableMultiRegex that can be used to walk
     * the content and find matches.
     *
     * @param {CompiledMode} mode
     * @returns {ResumableMultiRegex}
     */
    function buildModeRegex(mode) {
      const mm = new ResumableMultiRegex();

      mode.contains.forEach(term => mm.addRule(term.begin, { rule: term, type: "begin" }));

      if (mode.terminator_end) {
        mm.addRule(mode.terminator_end, { type: "end" });
      }
      if (mode.illegal) {
        mm.addRule(mode.illegal, { type: "illegal" });
      }

      return mm;
    }

    // TODO: We need negative look-behind support to do this properly
    /**
     * Skip a match if it has a preceding or trailing dot
     *
     * This is used for `beginKeywords` to prevent matching expressions such as
     * `bob.keyword.do()`. The mode compiler automatically wires this up as a
     * special _internal_ 'on:begin' callback for modes with `beginKeywords`
     * @param {RegExpMatchArray} match
     * @param {CallbackResponse} response
     */
    function skipIfhasPrecedingOrTrailingDot(match, response) {
      const before = match.input[match.index - 1];
      const after = match.input[match.index + match[0].length];
      if (before === "." || after === ".") {
        response.ignoreMatch();
      }
    }

    /** skip vs abort vs ignore
     *
     * @skip   - The mode is still entered and exited normally (and contains rules apply),
     *           but all content is held and added to the parent buffer rather than being
     *           output when the mode ends.  Mostly used with `sublanguage` to build up
     *           a single large buffer than can be parsed by sublanguage.
     *
     *             - The mode begin ands ends normally.
     *             - Content matched is added to the parent mode buffer.
     *             - The parser cursor is moved forward normally.
     *
     * @abort  - A hack placeholder until we have ignore.  Aborts the mode (as if it
     *           never matched) but DOES NOT continue to match subsequent `contains`
     *           modes.  Abort is bad/suboptimal because it can result in modes
     *           farther down not getting applied because an earlier rule eats the
     *           content but then aborts.
     *
     *             - The mode does not begin.
     *             - Content matched by `begin` is added to the mode buffer.
     *             - The parser cursor is moved forward accordingly.
     *
     * @ignore - Ignores the mode (as if it never matched) and continues to match any
     *           subsequent `contains` modes.  Ignore isn't technically possible with
     *           the current parser implementation.
     *
     *             - The mode does not begin.
     *             - Content matched by `begin` is ignored.
     *             - The parser cursor is not moved forward.
     */

    /**
     * Compiles an individual mode
     *
     * This can raise an error if the mode contains certain detectable known logic
     * issues.
     * @param {Mode} mode
     * @param {CompiledMode | null} [parent]
     * @returns {CompiledMode | never}
     */
    function compileMode(mode, parent) {
      const cmode = /** @type CompiledMode */ (mode);
      if (mode.compiled) return cmode;
      mode.compiled = true;

      // __beforeBegin is considered private API, internal use only
      mode.__beforeBegin = null;

      mode.keywords = mode.keywords || mode.beginKeywords;

      let keywordPattern = null;
      if (typeof mode.keywords === "object") {
        keywordPattern = mode.keywords.$pattern;
        delete mode.keywords.$pattern;
      }

      if (mode.keywords) {
        mode.keywords = compileKeywords(mode.keywords, language.case_insensitive);
      }

      // both are not allowed
      if (mode.lexemes && keywordPattern) {
        throw new Error("ERR: Prefer `keywords.$pattern` to `mode.lexemes`, BOTH are not allowed. (see mode reference) ");
      }

      // `mode.lexemes` was the old standard before we added and now recommend
      // using `keywords.$pattern` to pass the keyword pattern
      cmode.keywordPatternRe = langRe(mode.lexemes || keywordPattern || /\w+/, true);

      if (parent) {
        if (mode.beginKeywords) {
          // for languages with keywords that include non-word characters checking for
          // a word boundary is not sufficient, so instead we check for a word boundary
          // or whitespace - this does no harm in any case since our keyword engine
          // doesn't allow spaces in keywords anyways and we still check for the boundary
          // first
          mode.begin = '\\b(' + mode.beginKeywords.split(' ').join('|') + ')(?=\\b|\\s)';
          mode.__beforeBegin = skipIfhasPrecedingOrTrailingDot;
        }
        if (!mode.begin) mode.begin = /\B|\b/;
        cmode.beginRe = langRe(mode.begin);
        if (mode.endSameAsBegin) mode.end = mode.begin;
        if (!mode.end && !mode.endsWithParent) mode.end = /\B|\b/;
        if (mode.end) cmode.endRe = langRe(mode.end);
        cmode.terminator_end = source(mode.end) || '';
        if (mode.endsWithParent && parent.terminator_end) {
          cmode.terminator_end += (mode.end ? '|' : '') + parent.terminator_end;
        }
      }
      if (mode.illegal) cmode.illegalRe = langRe(mode.illegal);
      // eslint-disable-next-line no-undefined
      if (mode.relevance === undefined) mode.relevance = 1;
      if (!mode.contains) mode.contains = [];

      mode.contains = [].concat(...mode.contains.map(function(c) {
        return expandOrCloneMode(c === 'self' ? mode : c);
      }));
      mode.contains.forEach(function(c) { compileMode(/** @type Mode */ (c), cmode); });

      if (mode.starts) {
        compileMode(mode.starts, parent);
      }

      cmode.matcher = buildModeRegex(cmode);
      return cmode;
    }

    // self is not valid at the top-level
    if (language.contains && language.contains.includes('self')) {
      throw new Error("ERR: contains `self` is not supported at the top-level of a language.  See documentation.");
    }
    return compileMode(/** @type Mode */ (language));
  }

  /**
   * Determines if a mode has a dependency on it's parent or not
   *
   * If a mode does have a parent dependency then often we need to clone it if
   * it's used in multiple places so that each copy points to the correct parent,
   * where-as modes without a parent can often safely be re-used at the bottom of
   * a mode chain.
   *
   * @param {Mode | null} mode
   * @returns {boolean} - is there a dependency on the parent?
   * */
  function dependencyOnParent(mode) {
    if (!mode) return false;

    return mode.endsWithParent || dependencyOnParent(mode.starts);
  }

  /**
   * Expands a mode or clones it if necessary
   *
   * This is necessary for modes with parental dependenceis (see notes on
   * `dependencyOnParent`) and for nodes that have `variants` - which must then be
   * exploded into their own individual modes at compile time.
   *
   * @param {Mode} mode
   * @returns {Mode | Mode[]}
   * */
  function expandOrCloneMode(mode) {
    if (mode.variants && !mode.cached_variants) {
      mode.cached_variants = mode.variants.map(function(variant) {
        return inherit(mode, { variants: null }, variant);
      });
    }

    // EXPAND
    // if we have variants then essentially "replace" the mode with the variants
    // this happens in compileMode, where this function is called from
    if (mode.cached_variants) {
      return mode.cached_variants;
    }

    // CLONE
    // if we have dependencies on parents then we need a unique
    // instance of ourselves, so we can be reused with many
    // different parents without issue
    if (dependencyOnParent(mode)) {
      return inherit(mode, { starts: mode.starts ? inherit(mode.starts) : null });
    }

    if (Object.isFrozen(mode)) {
      return inherit(mode);
    }

    // no special dependency issues, just return ourselves
    return mode;
  }

  /***********************************************
    Keywords
  ***********************************************/

  /**
   * Given raw keywords from a language definition, compile them.
   *
   * @param {string | Record<string,string>} rawKeywords
   * @param {boolean} caseInsensitive
   */
  function compileKeywords(rawKeywords, caseInsensitive) {
    /** @type KeywordDict */
    var compiledKeywords = {};

    if (typeof rawKeywords === 'string') { // string
      splitAndCompile('keyword', rawKeywords);
    } else {
      Object.keys(rawKeywords).forEach(function(className) {
        splitAndCompile(className, rawKeywords[className]);
      });
    }
    return compiledKeywords;

    // ---

    /**
     * Compiles an individual list of keywords
     *
     * Ex: "for if when while|5"
     *
     * @param {string} className
     * @param {string} keywordList
     */
    function splitAndCompile(className, keywordList) {
      if (caseInsensitive) {
        keywordList = keywordList.toLowerCase();
      }
      keywordList.split(' ').forEach(function(keyword) {
        var pair = keyword.split('|');
        compiledKeywords[pair[0]] = [className, scoreForKeyword(pair[0], pair[1])];
      });
    }
  }

  /**
   * Returns the proper score for a given keyword
   *
   * Also takes into account comment keywords, which will be scored 0 UNLESS
   * another score has been manually assigned.
   * @param {string} keyword
   * @param {string} [providedScore]
   */
  function scoreForKeyword(keyword, providedScore) {
    // manual scores always win over common keywords
    // so you can force a score of 1 if you really insist
    if (providedScore) {
      return Number(providedScore);
    }

    return commonKeyword(keyword) ? 0 : 1;
  }

  /**
   * Determines if a given keyword is common or not
   *
   * @param {string} keyword */
  function commonKeyword(keyword) {
    return COMMON_KEYWORDS.includes(keyword.toLowerCase());
  }

  var version = "10.3.2";

  // @ts-nocheck

  function hasValueOrEmptyAttribute(value) {
    return Boolean(value || value === "");
  }

  const Component = {
    props: ["language", "code", "autodetect"],
    data: function() {
      return {
        detectedLanguage: "",
        unknownLanguage: false
      };
    },
    computed: {
      className() {
        if (this.unknownLanguage) return "";

        return "hljs " + this.detectedLanguage;
      },
      highlighted() {
        // no idea what language to use, return raw code
        if (!this.autoDetect && !hljs.getLanguage(this.language)) {
          console.warn(`The language "${this.language}" you specified could not be found.`);
          this.unknownLanguage = true;
          return escapeHTML(this.code);
        }

        let result;
        if (this.autoDetect) {
          result = hljs.highlightAuto(this.code);
          this.detectedLanguage = result.language;
        } else {
          result = hljs.highlight(this.language, this.code, this.ignoreIllegals);
          this.detectectLanguage = this.language;
        }
        return result.value;
      },
      autoDetect() {
        return !this.language || hasValueOrEmptyAttribute(this.autodetect);
      },
      ignoreIllegals() {
        return true;
      }
    },
    // this avoids needing to use a whole Vue compilation pipeline just
    // to build Highlight.js
    render(createElement) {
      return createElement("pre", {}, [
        createElement("code", {
          class: this.className,
          domProps: { innerHTML: this.highlighted }})
      ]);
    }
    // template: `<pre><code :class="className" v-html="highlighted"></code></pre>`
  };

  const VuePlugin = {
    install(Vue) {
      Vue.component('highlightjs', Component);
    }
  };

  /*
  Syntax highlighting with language autodetection.
  https://highlightjs.org/
  */

  const escape$1 = escapeHTML;
  const inherit$1 = inherit;

  const { nodeStream: nodeStream$1, mergeStreams: mergeStreams$1 } = utils;
  const NO_MATCH = Symbol("nomatch");

  /**
   * @param {any} hljs - object that is extended (legacy)
   * @returns {HLJSApi}
   */
  const HLJS = function(hljs) {
    // Convenience variables for build-in objects
    /** @type {unknown[]} */
    var ArrayProto = [];

    // Global internal variables used within the highlight.js library.
    /** @type {Record<string, Language>} */
    var languages = Object.create(null);
    /** @type {Record<string, string>} */
    var aliases = Object.create(null);
    /** @type {HLJSPlugin[]} */
    var plugins = [];

    // safe/production mode - swallows more errors, tries to keep running
    // even if a single syntax or parse hits a fatal error
    var SAFE_MODE = true;
    var fixMarkupRe = /(^(<[^>]+>|\t|)+|\n)/gm;
    var LANGUAGE_NOT_FOUND = "Could not find the language '{}', did you forget to load/include a language module?";
    /** @type {Language} */
    const PLAINTEXT_LANGUAGE = { disableAutodetect: true, name: 'Plain text', contains: [] };

    // Global options used when within external APIs. This is modified when
    // calling the `hljs.configure` function.
    /** @type HLJSOptions */
    var options = {
      noHighlightRe: /^(no-?highlight)$/i,
      languageDetectRe: /\blang(?:uage)?-([\w-]+)\b/i,
      classPrefix: 'hljs-',
      tabReplace: null,
      useBR: false,
      languages: null,
      // beta configuration options, subject to change, welcome to discuss
      // https://github.com/highlightjs/highlight.js/issues/1086
      __emitter: TokenTreeEmitter
    };

    /* Utility functions */

    /**
     * Tests a language name to see if highlighting should be skipped
     * @param {string} languageName
     */
    function shouldNotHighlight(languageName) {
      return options.noHighlightRe.test(languageName);
    }

    /**
     * @param {HighlightedHTMLElement} block - the HTML element to determine language for
     */
    function blockLanguage(block) {
      var classes = block.className + ' ';

      classes += block.parentNode ? block.parentNode.className : '';

      // language-* takes precedence over non-prefixed class names.
      const match = options.languageDetectRe.exec(classes);
      if (match) {
        var language = getLanguage(match[1]);
        if (!language) {
          console.warn(LANGUAGE_NOT_FOUND.replace("{}", match[1]));
          console.warn("Falling back to no-highlight mode for this block.", block);
        }
        return language ? match[1] : 'no-highlight';
      }

      return classes
        .split(/\s+/)
        .find((_class) => shouldNotHighlight(_class) || getLanguage(_class));
    }

    /**
     * Core highlighting function.
     *
     * @param {string} languageName - the language to use for highlighting
     * @param {string} code - the code to highlight
     * @param {boolean} [ignoreIllegals] - whether to ignore illegal matches, default is to bail
     * @param {Mode} [continuation] - current continuation mode, if any
     *
     * @returns {HighlightResult} Result - an object that represents the result
     * @property {string} language - the language name
     * @property {number} relevance - the relevance score
     * @property {string} value - the highlighted HTML code
     * @property {string} code - the original raw code
     * @property {Mode} top - top of the current mode stack
     * @property {boolean} illegal - indicates whether any illegal matches were found
    */
    function highlight(languageName, code, ignoreIllegals, continuation) {
      /** @type {{ code: string, language: string, result?: any }} */
      var context = {
        code,
        language: languageName
      };
      // the plugin can change the desired language or the code to be highlighted
      // just be changing the object it was passed
      fire("before:highlight", context);

      // a before plugin can usurp the result completely by providing it's own
      // in which case we don't even need to call highlight
      var result = context.result ?
        context.result :
        _highlight(context.language, context.code, ignoreIllegals, continuation);

      result.code = context.code;
      // the plugin can change anything in result to suite it
      fire("after:highlight", result);

      return result;
    }

    /**
     * private highlight that's used internally and does not fire callbacks
     *
     * @param {string} languageName - the language to use for highlighting
     * @param {string} code - the code to highlight
     * @param {boolean} [ignoreIllegals] - whether to ignore illegal matches, default is to bail
     * @param {Mode} [continuation] - current continuation mode, if any
    */
    function _highlight(languageName, code, ignoreIllegals, continuation) {
      var codeToHighlight = code;

      /**
       * Return keyword data if a match is a keyword
       * @param {CompiledMode} mode - current mode
       * @param {RegExpMatchArray} match - regexp match data
       * @returns {KeywordData | false}
       */
      function keywordData(mode, match) {
        var matchText = language.case_insensitive ? match[0].toLowerCase() : match[0];
        return Object.prototype.hasOwnProperty.call(mode.keywords, matchText) && mode.keywords[matchText];
      }

      function processKeywords() {
        if (!top.keywords) {
          emitter.addText(modeBuffer);
          return;
        }

        let lastIndex = 0;
        top.keywordPatternRe.lastIndex = 0;
        let match = top.keywordPatternRe.exec(modeBuffer);
        let buf = "";

        while (match) {
          buf += modeBuffer.substring(lastIndex, match.index);
          const data = keywordData(top, match);
          if (data) {
            const [kind, keywordRelevance] = data;
            emitter.addText(buf);
            buf = "";

            relevance += keywordRelevance;
            emitter.addKeyword(match[0], kind);
          } else {
            buf += match[0];
          }
          lastIndex = top.keywordPatternRe.lastIndex;
          match = top.keywordPatternRe.exec(modeBuffer);
        }
        buf += modeBuffer.substr(lastIndex);
        emitter.addText(buf);
      }

      function processSubLanguage() {
        if (modeBuffer === "") return;
        /** @type HighlightResult */
        var result = null;

        if (typeof top.subLanguage === 'string') {
          if (!languages[top.subLanguage]) {
            emitter.addText(modeBuffer);
            return;
          }
          result = _highlight(top.subLanguage, modeBuffer, true, continuations[top.subLanguage]);
          continuations[top.subLanguage] = result.top;
        } else {
          result = highlightAuto(modeBuffer, top.subLanguage.length ? top.subLanguage : null);
        }

        // Counting embedded language score towards the host language may be disabled
        // with zeroing the containing mode relevance. Use case in point is Markdown that
        // allows XML everywhere and makes every XML snippet to have a much larger Markdown
        // score.
        if (top.relevance > 0) {
          relevance += result.relevance;
        }
        emitter.addSublanguage(result.emitter, result.language);
      }

      function processBuffer() {
        if (top.subLanguage != null) {
          processSubLanguage();
        } else {
          processKeywords();
        }
        modeBuffer = '';
      }

      /**
       * @param {Mode} mode - new mode to start
       */
      function startNewMode(mode) {
        if (mode.className) {
          emitter.openNode(mode.className);
        }
        top = Object.create(mode, { parent: { value: top } });
        return top;
      }

      /**
       * @param {CompiledMode } mode - the mode to potentially end
       * @param {RegExpMatchArray} match - the latest match
       * @param {string} matchPlusRemainder - match plus remainder of content
       * @returns {CompiledMode | void} - the next mode, or if void continue on in current mode
       */
      function endOfMode(mode, match, matchPlusRemainder) {
        let matched = startsWith(mode.endRe, matchPlusRemainder);

        if (matched) {
          if (mode["on:end"]) {
            const resp = new Response(mode);
            mode["on:end"](match, resp);
            if (resp.ignore) matched = false;
          }

          if (matched) {
            while (mode.endsParent && mode.parent) {
              mode = mode.parent;
            }
            return mode;
          }
        }
        // even if on:end fires an `ignore` it's still possible
        // that we might trigger the end node because of a parent mode
        if (mode.endsWithParent) {
          return endOfMode(mode.parent, match, matchPlusRemainder);
        }
      }

      /**
       * Handle matching but then ignoring a sequence of text
       *
       * @param {string} lexeme - string containing full match text
       */
      function doIgnore(lexeme) {
        if (top.matcher.regexIndex === 0) {
          // no more regexs to potentially match here, so we move the cursor forward one
          // space
          modeBuffer += lexeme[0];
          return 1;
        } else {
          // no need to move the cursor, we still have additional regexes to try and
          // match at this very spot
          resumeScanAtSamePosition = true;
          return 0;
        }
      }

      /**
       * Handle the start of a new potential mode match
       *
       * @param {EnhancedMatch} match - the current match
       * @returns {number} how far to advance the parse cursor
       */
      function doBeginMatch(match) {
        var lexeme = match[0];
        var newMode = match.rule;

        const resp = new Response(newMode);
        // first internal before callbacks, then the public ones
        const beforeCallbacks = [newMode.__beforeBegin, newMode["on:begin"]];
        for (const cb of beforeCallbacks) {
          if (!cb) continue;
          cb(match, resp);
          if (resp.ignore) return doIgnore(lexeme);
        }

        if (newMode && newMode.endSameAsBegin) {
          newMode.endRe = escape(lexeme);
        }

        if (newMode.skip) {
          modeBuffer += lexeme;
        } else {
          if (newMode.excludeBegin) {
            modeBuffer += lexeme;
          }
          processBuffer();
          if (!newMode.returnBegin && !newMode.excludeBegin) {
            modeBuffer = lexeme;
          }
        }
        startNewMode(newMode);
        // if (mode["after:begin"]) {
        //   let resp = new Response(mode);
        //   mode["after:begin"](match, resp);
        // }
        return newMode.returnBegin ? 0 : lexeme.length;
      }

      /**
       * Handle the potential end of mode
       *
       * @param {RegExpMatchArray} match - the current match
       */
      function doEndMatch(match) {
        var lexeme = match[0];
        var matchPlusRemainder = codeToHighlight.substr(match.index);

        var endMode = endOfMode(top, match, matchPlusRemainder);
        if (!endMode) { return NO_MATCH; }

        var origin = top;
        if (origin.skip) {
          modeBuffer += lexeme;
        } else {
          if (!(origin.returnEnd || origin.excludeEnd)) {
            modeBuffer += lexeme;
          }
          processBuffer();
          if (origin.excludeEnd) {
            modeBuffer = lexeme;
          }
        }
        do {
          if (top.className) {
            emitter.closeNode();
          }
          if (!top.skip && !top.subLanguage) {
            relevance += top.relevance;
          }
          top = top.parent;
        } while (top !== endMode.parent);
        if (endMode.starts) {
          if (endMode.endSameAsBegin) {
            endMode.starts.endRe = endMode.endRe;
          }
          startNewMode(endMode.starts);
        }
        return origin.returnEnd ? 0 : lexeme.length;
      }

      function processContinuations() {
        var list = [];
        for (var current = top; current !== language; current = current.parent) {
          if (current.className) {
            list.unshift(current.className);
          }
        }
        list.forEach(item => emitter.openNode(item));
      }

      /** @type {{type?: MatchType, index?: number, rule?: Mode}}} */
      var lastMatch = {};

      /**
       *  Process an individual match
       *
       * @param {string} textBeforeMatch - text preceeding the match (since the last match)
       * @param {EnhancedMatch} [match] - the match itself
       */
      function processLexeme(textBeforeMatch, match) {
        var lexeme = match && match[0];

        // add non-matched text to the current mode buffer
        modeBuffer += textBeforeMatch;

        if (lexeme == null) {
          processBuffer();
          return 0;
        }

        // we've found a 0 width match and we're stuck, so we need to advance
        // this happens when we have badly behaved rules that have optional matchers to the degree that
        // sometimes they can end up matching nothing at all
        // Ref: https://github.com/highlightjs/highlight.js/issues/2140
        if (lastMatch.type === "begin" && match.type === "end" && lastMatch.index === match.index && lexeme === "") {
          // spit the "skipped" character that our regex choked on back into the output sequence
          modeBuffer += codeToHighlight.slice(match.index, match.index + 1);
          if (!SAFE_MODE) {
            /** @type {AnnotatedError} */
            const err = new Error('0 width match regex');
            err.languageName = languageName;
            err.badRule = lastMatch.rule;
            throw err;
          }
          return 1;
        }
        lastMatch = match;

        if (match.type === "begin") {
          return doBeginMatch(match);
        } else if (match.type === "illegal" && !ignoreIllegals) {
          // illegal match, we do not continue processing
          /** @type {AnnotatedError} */
          const err = new Error('Illegal lexeme "' + lexeme + '" for mode "' + (top.className || '<unnamed>') + '"');
          err.mode = top;
          throw err;
        } else if (match.type === "end") {
          var processed = doEndMatch(match);
          if (processed !== NO_MATCH) {
            return processed;
          }
        }

        // edge case for when illegal matches $ (end of line) which is technically
        // a 0 width match but not a begin/end match so it's not caught by the
        // first handler (when ignoreIllegals is true)
        if (match.type === "illegal" && lexeme === "") {
          // advance so we aren't stuck in an infinite loop
          return 1;
        }

        // infinite loops are BAD, this is a last ditch catch all. if we have a
        // decent number of iterations yet our index (cursor position in our
        // parsing) still 3x behind our index then something is very wrong
        // so we bail
        if (iterations > 100000 && iterations > match.index * 3) {
          const err = new Error('potential infinite loop, way more iterations than matches');
          throw err;
        }

        /*
        Why might be find ourselves here?  Only one occasion now.  An end match that was
        triggered but could not be completed.  When might this happen?  When an `endSameasBegin`
        rule sets the end rule to a specific match.  Since the overall mode termination rule that's
        being used to scan the text isn't recompiled that means that any match that LOOKS like
        the end (but is not, because it is not an exact match to the beginning) will
        end up here.  A definite end match, but when `doEndMatch` tries to "reapply"
        the end rule and fails to match, we wind up here, and just silently ignore the end.

        This causes no real harm other than stopping a few times too many.
        */

        modeBuffer += lexeme;
        return lexeme.length;
      }

      var language = getLanguage(languageName);
      if (!language) {
        console.error(LANGUAGE_NOT_FOUND.replace("{}", languageName));
        throw new Error('Unknown language: "' + languageName + '"');
      }

      var md = compileLanguage(language);
      var result = '';
      /** @type {CompiledMode} */
      var top = continuation || md;
      /** @type Record<string,Mode> */
      var continuations = {}; // keep continuations for sub-languages
      var emitter = new options.__emitter(options);
      processContinuations();
      var modeBuffer = '';
      var relevance = 0;
      var index = 0;
      var iterations = 0;
      var resumeScanAtSamePosition = false;

      try {
        top.matcher.considerAll();

        for (;;) {
          iterations++;
          if (resumeScanAtSamePosition) {
            // only regexes not matched previously will now be
            // considered for a potential match
            resumeScanAtSamePosition = false;
          } else {
            top.matcher.considerAll();
          }
          top.matcher.lastIndex = index;

          const match = top.matcher.exec(codeToHighlight);
          // console.log("match", match[0], match.rule && match.rule.begin)

          if (!match) break;

          const beforeMatch = codeToHighlight.substring(index, match.index);
          const processedCount = processLexeme(beforeMatch, match);
          index = match.index + processedCount;
        }
        processLexeme(codeToHighlight.substr(index));
        emitter.closeAllNodes();
        emitter.finalize();
        result = emitter.toHTML();

        return {
          relevance: relevance,
          value: result,
          language: languageName,
          illegal: false,
          emitter: emitter,
          top: top
        };
      } catch (err) {
        if (err.message && err.message.includes('Illegal')) {
          return {
            illegal: true,
            illegalBy: {
              msg: err.message,
              context: codeToHighlight.slice(index - 100, index + 100),
              mode: err.mode
            },
            sofar: result,
            relevance: 0,
            value: escape$1(codeToHighlight),
            emitter: emitter
          };
        } else if (SAFE_MODE) {
          return {
            illegal: false,
            relevance: 0,
            value: escape$1(codeToHighlight),
            emitter: emitter,
            language: languageName,
            top: top,
            errorRaised: err
          };
        } else {
          throw err;
        }
      }
    }

    /**
     * returns a valid highlight result, without actually doing any actual work,
     * auto highlight starts with this and it's possible for small snippets that
     * auto-detection may not find a better match
     * @param {string} code
     * @returns {HighlightResult}
     */
    function justTextHighlightResult(code) {
      const result = {
        relevance: 0,
        emitter: new options.__emitter(options),
        value: escape$1(code),
        illegal: false,
        top: PLAINTEXT_LANGUAGE
      };
      result.emitter.addText(code);
      return result;
    }

    /**
    Highlighting with language detection. Accepts a string with the code to
    highlight. Returns an object with the following properties:

    - language (detected language)
    - relevance (int)
    - value (an HTML string with highlighting markup)
    - second_best (object with the same structure for second-best heuristically
      detected language, may be absent)

      @param {string} code
      @param {Array<string>} [languageSubset]
      @returns {AutoHighlightResult}
    */
    function highlightAuto(code, languageSubset) {
      languageSubset = languageSubset || options.languages || Object.keys(languages);
      var result = justTextHighlightResult(code);
      var secondBest = result;
      languageSubset.filter(getLanguage).filter(autoDetection).forEach(function(name) {
        var current = _highlight(name, code, false);
        current.language = name;
        if (current.relevance > secondBest.relevance) {
          secondBest = current;
        }
        if (current.relevance > result.relevance) {
          secondBest = result;
          result = current;
        }
      });
      if (secondBest.language) {
        // second_best (with underscore) is the expected API
        result.second_best = secondBest;
      }
      return result;
    }

    /**
    Post-processing of the highlighted markup:

    - replace TABs with something more useful
    - replace real line-breaks with '<br>' for non-pre containers

      @param {string} html
      @returns {string}
    */
    function fixMarkup(html) {
      if (!(options.tabReplace || options.useBR)) {
        return html;
      }

      return html.replace(fixMarkupRe, match => {
        if (match === '\n') {
          return options.useBR ? '<br>' : match;
        } else if (options.tabReplace) {
          return match.replace(/\t/g, options.tabReplace);
        }
        return match;
      });
    }

    /**
     * Builds new class name for block given the language name
     *
     * @param {string} prevClassName
     * @param {string} [currentLang]
     * @param {string} [resultLang]
     */
    function buildClassName(prevClassName, currentLang, resultLang) {
      var language = currentLang ? aliases[currentLang] : resultLang;
      var result = [prevClassName.trim()];

      if (!prevClassName.match(/\bhljs\b/)) {
        result.push('hljs');
      }

      if (!prevClassName.includes(language)) {
        result.push(language);
      }

      return result.join(' ').trim();
    }

    /**
     * Applies highlighting to a DOM node containing code. Accepts a DOM node and
     * two optional parameters for fixMarkup.
     *
     * @param {HighlightedHTMLElement} element - the HTML element to highlight
    */
    function highlightBlock(element) {
      /** @type HTMLElement */
      let node = null;
      const language = blockLanguage(element);

      if (shouldNotHighlight(language)) return;

      fire("before:highlightBlock",
        { block: element, language: language });

      if (options.useBR) {
        node = document.createElement('div');
        node.innerHTML = element.innerHTML.replace(/\n/g, '').replace(/<br[ /]*>/g, '\n');
      } else {
        node = element;
      }
      const text = node.textContent;
      const result = language ? highlight(language, text, true) : highlightAuto(text);

      const originalStream = nodeStream$1(node);
      if (originalStream.length) {
        const resultNode = document.createElement('div');
        resultNode.innerHTML = result.value;
        result.value = mergeStreams$1(originalStream, nodeStream$1(resultNode), text);
      }
      result.value = fixMarkup(result.value);

      fire("after:highlightBlock", { block: element, result: result });

      element.innerHTML = result.value;
      element.className = buildClassName(element.className, language, result.language);
      element.result = {
        language: result.language,
        // TODO: remove with version 11.0
        re: result.relevance,
        relavance: result.relevance
      };
      if (result.second_best) {
        element.second_best = {
          language: result.second_best.language,
          // TODO: remove with version 11.0
          re: result.second_best.relevance,
          relavance: result.second_best.relevance
        };
      }
    }

    /**
     * Updates highlight.js global options with the passed options
     *
     * @param {{}} userOptions
     */
    function configure(userOptions) {
      if (userOptions.useBR) {
        console.warn("'useBR' option is deprecated and will be removed entirely in v11.0");
        console.warn("Please see https://github.com/highlightjs/highlight.js/issues/2559");
      }
      options = inherit$1(options, userOptions);
    }

    /**
     * Highlights to all <pre><code> blocks on a page
     *
     * @type {Function & {called?: boolean}}
     */
    const initHighlighting = () => {
      if (initHighlighting.called) return;
      initHighlighting.called = true;

      var blocks = document.querySelectorAll('pre code');
      ArrayProto.forEach.call(blocks, highlightBlock);
    };

    // Higlights all when DOMContentLoaded fires
    function initHighlightingOnLoad() {
      // @ts-ignore
      window.addEventListener('DOMContentLoaded', initHighlighting, false);
    }

    /**
     * Register a language grammar module
     *
     * @param {string} languageName
     * @param {LanguageFn} languageDefinition
     */
    function registerLanguage(languageName, languageDefinition) {
      var lang = null;
      try {
        lang = languageDefinition(hljs);
      } catch (error) {
        console.error("Language definition for '{}' could not be registered.".replace("{}", languageName));
        // hard or soft error
        if (!SAFE_MODE) { throw error; } else { console.error(error); }
        // languages that have serious errors are replaced with essentially a
        // "plaintext" stand-in so that the code blocks will still get normal
        // css classes applied to them - and one bad language won't break the
        // entire highlighter
        lang = PLAINTEXT_LANGUAGE;
      }
      // give it a temporary name if it doesn't have one in the meta-data
      if (!lang.name) lang.name = languageName;
      languages[languageName] = lang;
      lang.rawDefinition = languageDefinition.bind(null, hljs);

      if (lang.aliases) {
        registerAliases(lang.aliases, { languageName });
      }
    }

    /**
     * @returns {string[]} List of language internal names
     */
    function listLanguages() {
      return Object.keys(languages);
    }

    /**
      intended usage: When one language truly requires another

      Unlike `getLanguage`, this will throw when the requested language
      is not available.

      @param {string} name - name of the language to fetch/require
      @returns {Language | never}
    */
    function requireLanguage(name) {
      var lang = getLanguage(name);
      if (lang) { return lang; }

      var err = new Error('The \'{}\' language is required, but not loaded.'.replace('{}', name));
      throw err;
    }

    /**
     * @param {string} name - name of the language to retrieve
     * @returns {Language | undefined}
     */
    function getLanguage(name) {
      name = (name || '').toLowerCase();
      return languages[name] || languages[aliases[name]];
    }

    /**
     *
     * @param {string|string[]} aliasList - single alias or list of aliases
     * @param {{languageName: string}} opts
     */
    function registerAliases(aliasList, { languageName }) {
      if (typeof aliasList === 'string') {
        aliasList = [aliasList];
      }
      aliasList.forEach(alias => { aliases[alias] = languageName; });
    }

    /**
     * Determines if a given language has auto-detection enabled
     * @param {string} name - name of the language
     */
    function autoDetection(name) {
      var lang = getLanguage(name);
      return lang && !lang.disableAutodetect;
    }

    /**
     * @param {HLJSPlugin} plugin
     */
    function addPlugin(plugin) {
      plugins.push(plugin);
    }

    /**
     *
     * @param {PluginEvent} event
     * @param {any} args
     */
    function fire(event, args) {
      var cb = event;
      plugins.forEach(function(plugin) {
        if (plugin[cb]) {
          plugin[cb](args);
        }
      });
    }

    /**
    Note: fixMarkup is deprecated and will be removed entirely in v11

    @param {string} arg
    @returns {string}
    */
    function deprecateFixMarkup(arg) {
      console.warn("fixMarkup is deprecated and will be removed entirely in v11.0");
      console.warn("Please see https://github.com/highlightjs/highlight.js/issues/2534");

      return fixMarkup(arg);
    }

    /* Interface definition */
    Object.assign(hljs, {
      highlight,
      highlightAuto,
      fixMarkup: deprecateFixMarkup,
      highlightBlock,
      configure,
      initHighlighting,
      initHighlightingOnLoad,
      registerLanguage,
      listLanguages,
      getLanguage,
      registerAliases,
      requireLanguage,
      autoDetection,
      inherit: inherit$1,
      addPlugin,
      // plugins for frameworks
      vuePlugin: VuePlugin
    });

    hljs.debugMode = function() { SAFE_MODE = false; };
    hljs.safeMode = function() { SAFE_MODE = true; };
    hljs.versionString = version;

    for (const key in MODES) {
      // @ts-ignore
      if (typeof MODES[key] === "object") {
        // @ts-ignore
        deepFreeze(MODES[key]);
      }
    }

    // merge all the modes/regexs into our main object
    Object.assign(hljs, MODES);

    return hljs;
  };

  // export an "instance" of the highlighter
  var highlight = HLJS({});

  return highlight;

}());
if (typeof exports === 'object' && typeof module !== 'undefined') { module.exports = hljs; }

hljs.registerLanguage('python', function () {
  'use strict';

  /*
  Language: Python
  Description: Python is an interpreted, object-oriented, high-level programming language with dynamic semantics.
  Website: https://www.python.org
  Category: common
  */

  function python(hljs) {
    const RESERVED_WORDS = [
      'and',
      'as',
      'assert',
      'async',
      'await',
      'break',
      'class',
      'continue',
      'def',
      'del',
      'elif',
      'else',
      'except',
      'finally',
      'for',
      '',
      'from',
      'global',
      'if',
      'import',
      'in',
      'is',
      'lambda',
      'nonlocal|10',
      'not',
      'or',
      'pass',
      'raise',
      'return',
      'try',
      'while',
      'with',
      'yield',
    ];

    const BUILT_INS = [
      '__import__',
      'abs',
      'all',
      'any',
      'ascii',
      'bin',
      'bool',
      'breakpoint',
      'bytearray',
      'bytes',
      'callable',
      'chr',
      'classmethod',
      'compile',
      'complex',
      'delattr',
      'dict',
      'dir',
      'divmod',
      'enumerate',
      'eval',
      'exec',
      'filter',
      'float',
      'format',
      'frozenset',
      'getattr',
      'globals',
      'hasattr',
      'hash',
      'help',
      'hex',
      'id',
      'input',
      'int',
      'isinstance',
      'issubclass',
      'iter',
      'len',
      'list',
      'locals',
      'map',
      'max',
      'memoryview',
      'min',
      'next',
      'object',
      'oct',
      'open',
      'ord',
      'pow',
      'print',
      'property',
      'range',
      'repr',
      'reversed',
      'round',
      'set',
      'setattr',
      'slice',
      'sorted',
      'staticmethod',
      'str',
      'sum',
      'super',
      'tuple',
      'type',
      'vars',
      'zip',
    ];

    const LITERALS = [
      '__debug__',
      'Ellipsis',
      'False',
      'None',
      'NotImplemented',
      'True',
    ];

    const KEYWORDS = {
      keyword: RESERVED_WORDS.join(' '),
      built_in: BUILT_INS.join(' '),
      literal: LITERALS.join(' ')
    };

    const PROMPT = {
      className: 'meta',  begin: /^(>>>|\.\.\.) /
    };

    const SUBST = {
      className: 'subst',
      begin: /\{/, end: /\}/,
      keywords: KEYWORDS,
      illegal: /#/
    };

    const LITERAL_BRACKET = {
      begin: /\{\{/,
      relevance: 0
    };

    const STRING = {
      className: 'string',
      contains: [hljs.BACKSLASH_ESCAPE],
      variants: [
        {
          begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?'''/, end: /'''/,
          contains: [hljs.BACKSLASH_ESCAPE, PROMPT],
          relevance: 10
        },
        {
          begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?"""/, end: /"""/,
          contains: [hljs.BACKSLASH_ESCAPE, PROMPT],
          relevance: 10
        },
        {
          begin: /([fF][rR]|[rR][fF]|[fF])'''/, end: /'''/,
          contains: [hljs.BACKSLASH_ESCAPE, PROMPT, LITERAL_BRACKET, SUBST]
        },
        {
          begin: /([fF][rR]|[rR][fF]|[fF])"""/, end: /"""/,
          contains: [hljs.BACKSLASH_ESCAPE, PROMPT, LITERAL_BRACKET, SUBST]
        },
        {
          begin: /([uU]|[rR])'/, end: /'/,
          relevance: 10
        },
        {
          begin: /([uU]|[rR])"/, end: /"/,
          relevance: 10
        },
        {
          begin: /([bB]|[bB][rR]|[rR][bB])'/, end: /'/
        },
        {
          begin: /([bB]|[bB][rR]|[rR][bB])"/, end: /"/
        },
        {
          begin: /([fF][rR]|[rR][fF]|[fF])'/, end: /'/,
          contains: [hljs.BACKSLASH_ESCAPE, LITERAL_BRACKET, SUBST]
        },
        {
          begin: /([fF][rR]|[rR][fF]|[fF])"/, end: /"/,
          contains: [hljs.BACKSLASH_ESCAPE, LITERAL_BRACKET, SUBST]
        },
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ]
    };

    const NUMBER = {
      className: 'number', relevance: 0,
      variants: [
        {begin: hljs.BINARY_NUMBER_RE + '[lLjJ]?'},
        {begin: '\\b(0o[0-7]+)[lLjJ]?'},
        {begin: hljs.C_NUMBER_RE + '[lLjJ]?'}
      ]
    };

    const PARAMS = {
      className: 'params',
      variants: [
        // Exclude params at functions without params
        {begin: /\(\s*\)/, skip: true, className: null },
        {
          begin: /\(/, end: /\)/, excludeBegin: true, excludeEnd: true,
          keywords: KEYWORDS,
          contains: ['self', PROMPT, NUMBER, STRING, hljs.HASH_COMMENT_MODE],
        },
      ],
    };
    SUBST.contains = [STRING, NUMBER, PROMPT];

    return {
      name: 'Python',
      aliases: ['py', 'gyp', 'ipython'],
      keywords: KEYWORDS,
      illegal: /(<\/|->|\?)|=>/,
      contains: [
        PROMPT,
        NUMBER,
        // eat "if" prior to string so that it won't accidentally be
        // labeled as an f-string as in:
        { beginKeywords: "if", relevance: 0 },
        STRING,
        hljs.HASH_COMMENT_MODE,
        {
          variants: [
            {className: 'function', beginKeywords: 'def'},
            {className: 'class', beginKeywords: 'class'}
          ],
          end: /:/,
          illegal: /[${=;\n,]/,
          contains: [
            hljs.UNDERSCORE_TITLE_MODE,
            PARAMS,
            {
              begin: /->/, endsWithParent: true,
              keywords: 'None'
            }
          ]
        },
        {
          className: 'meta',
          begin: /^[\t ]*@/, end: /$/
        },
        {
          begin: /\b(print|exec)\(/ // don’t highlight keywords-turned-functions in Python 3
        }
      ]
    };
  }

  return python;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('x86asm', function () {
  'use strict';

  /*
  Language: Intel x86 Assembly
  Author: innocenat <innocenat@gmail.com>
  Description: x86 assembly language using Intel's mnemonic and NASM syntax
  Website: https://en.wikipedia.org/wiki/X86_assembly_language
  Category: assembler
  */

  function x86asm(hljs) {
    return {
      name: 'Intel x86 Assembly',
      case_insensitive: true,
      keywords: {
        $pattern: '[.%]?' + hljs.IDENT_RE,
        keyword:
          'lock rep repe repz repne repnz xaquire xrelease bnd nobnd ' +
          'aaa aad aam aas adc add and arpl bb0_reset bb1_reset bound bsf bsr bswap bt btc btr bts call cbw cdq cdqe clc cld cli clts cmc cmp cmpsb cmpsd cmpsq cmpsw cmpxchg cmpxchg486 cmpxchg8b cmpxchg16b cpuid cpu_read cpu_write cqo cwd cwde daa das dec div dmint emms enter equ f2xm1 fabs fadd faddp fbld fbstp fchs fclex fcmovb fcmovbe fcmove fcmovnb fcmovnbe fcmovne fcmovnu fcmovu fcom fcomi fcomip fcomp fcompp fcos fdecstp fdisi fdiv fdivp fdivr fdivrp femms feni ffree ffreep fiadd ficom ficomp fidiv fidivr fild fimul fincstp finit fist fistp fisttp fisub fisubr fld fld1 fldcw fldenv fldl2e fldl2t fldlg2 fldln2 fldpi fldz fmul fmulp fnclex fndisi fneni fninit fnop fnsave fnstcw fnstenv fnstsw fpatan fprem fprem1 fptan frndint frstor fsave fscale fsetpm fsin fsincos fsqrt fst fstcw fstenv fstp fstsw fsub fsubp fsubr fsubrp ftst fucom fucomi fucomip fucomp fucompp fxam fxch fxtract fyl2x fyl2xp1 hlt ibts icebp idiv imul in inc incbin insb insd insw int int01 int1 int03 int3 into invd invpcid invlpg invlpga iret iretd iretq iretw jcxz jecxz jrcxz jmp jmpe lahf lar lds lea leave les lfence lfs lgdt lgs lidt lldt lmsw loadall loadall286 lodsb lodsd lodsq lodsw loop loope loopne loopnz loopz lsl lss ltr mfence monitor mov movd movq movsb movsd movsq movsw movsx movsxd movzx mul mwait neg nop not or out outsb outsd outsw packssdw packsswb packuswb paddb paddd paddsb paddsiw paddsw paddusb paddusw paddw pand pandn pause paveb pavgusb pcmpeqb pcmpeqd pcmpeqw pcmpgtb pcmpgtd pcmpgtw pdistib pf2id pfacc pfadd pfcmpeq pfcmpge pfcmpgt pfmax pfmin pfmul pfrcp pfrcpit1 pfrcpit2 pfrsqit1 pfrsqrt pfsub pfsubr pi2fd pmachriw pmaddwd pmagw pmulhriw pmulhrwa pmulhrwc pmulhw pmullw pmvgezb pmvlzb pmvnzb pmvzb pop popa popad popaw popf popfd popfq popfw por prefetch prefetchw pslld psllq psllw psrad psraw psrld psrlq psrlw psubb psubd psubsb psubsiw psubsw psubusb psubusw psubw punpckhbw punpckhdq punpckhwd punpcklbw punpckldq punpcklwd push pusha pushad pushaw pushf pushfd pushfq pushfw pxor rcl rcr rdshr rdmsr rdpmc rdtsc rdtscp ret retf retn rol ror rdm rsdc rsldt rsm rsts sahf sal salc sar sbb scasb scasd scasq scasw sfence sgdt shl shld shr shrd sidt sldt skinit smi smint smintold smsw stc std sti stosb stosd stosq stosw str sub svdc svldt svts swapgs syscall sysenter sysexit sysret test ud0 ud1 ud2b ud2 ud2a umov verr verw fwait wbinvd wrshr wrmsr xadd xbts xchg xlatb xlat xor cmove cmovz cmovne cmovnz cmova cmovnbe cmovae cmovnb cmovb cmovnae cmovbe cmovna cmovg cmovnle cmovge cmovnl cmovl cmovnge cmovle cmovng cmovc cmovnc cmovo cmovno cmovs cmovns cmovp cmovpe cmovnp cmovpo je jz jne jnz ja jnbe jae jnb jb jnae jbe jna jg jnle jge jnl jl jnge jle jng jc jnc jo jno js jns jpo jnp jpe jp sete setz setne setnz seta setnbe setae setnb setnc setb setnae setcset setbe setna setg setnle setge setnl setl setnge setle setng sets setns seto setno setpe setp setpo setnp addps addss andnps andps cmpeqps cmpeqss cmpleps cmpless cmpltps cmpltss cmpneqps cmpneqss cmpnleps cmpnless cmpnltps cmpnltss cmpordps cmpordss cmpunordps cmpunordss cmpps cmpss comiss cvtpi2ps cvtps2pi cvtsi2ss cvtss2si cvttps2pi cvttss2si divps divss ldmxcsr maxps maxss minps minss movaps movhps movlhps movlps movhlps movmskps movntps movss movups mulps mulss orps rcpps rcpss rsqrtps rsqrtss shufps sqrtps sqrtss stmxcsr subps subss ucomiss unpckhps unpcklps xorps fxrstor fxrstor64 fxsave fxsave64 xgetbv xsetbv xsave xsave64 xsaveopt xsaveopt64 xrstor xrstor64 prefetchnta prefetcht0 prefetcht1 prefetcht2 maskmovq movntq pavgb pavgw pextrw pinsrw pmaxsw pmaxub pminsw pminub pmovmskb pmulhuw psadbw pshufw pf2iw pfnacc pfpnacc pi2fw pswapd maskmovdqu clflush movntdq movnti movntpd movdqa movdqu movdq2q movq2dq paddq pmuludq pshufd pshufhw pshuflw pslldq psrldq psubq punpckhqdq punpcklqdq addpd addsd andnpd andpd cmpeqpd cmpeqsd cmplepd cmplesd cmpltpd cmpltsd cmpneqpd cmpneqsd cmpnlepd cmpnlesd cmpnltpd cmpnltsd cmpordpd cmpordsd cmpunordpd cmpunordsd cmppd comisd cvtdq2pd cvtdq2ps cvtpd2dq cvtpd2pi cvtpd2ps cvtpi2pd cvtps2dq cvtps2pd cvtsd2si cvtsd2ss cvtsi2sd cvtss2sd cvttpd2pi cvttpd2dq cvttps2dq cvttsd2si divpd divsd maxpd maxsd minpd minsd movapd movhpd movlpd movmskpd movupd mulpd mulsd orpd shufpd sqrtpd sqrtsd subpd subsd ucomisd unpckhpd unpcklpd xorpd addsubpd addsubps haddpd haddps hsubpd hsubps lddqu movddup movshdup movsldup clgi stgi vmcall vmclear vmfunc vmlaunch vmload vmmcall vmptrld vmptrst vmread vmresume vmrun vmsave vmwrite vmxoff vmxon invept invvpid pabsb pabsw pabsd palignr phaddw phaddd phaddsw phsubw phsubd phsubsw pmaddubsw pmulhrsw pshufb psignb psignw psignd extrq insertq movntsd movntss lzcnt blendpd blendps blendvpd blendvps dppd dpps extractps insertps movntdqa mpsadbw packusdw pblendvb pblendw pcmpeqq pextrb pextrd pextrq phminposuw pinsrb pinsrd pinsrq pmaxsb pmaxsd pmaxud pmaxuw pminsb pminsd pminud pminuw pmovsxbw pmovsxbd pmovsxbq pmovsxwd pmovsxwq pmovsxdq pmovzxbw pmovzxbd pmovzxbq pmovzxwd pmovzxwq pmovzxdq pmuldq pmulld ptest roundpd roundps roundsd roundss crc32 pcmpestri pcmpestrm pcmpistri pcmpistrm pcmpgtq popcnt getsec pfrcpv pfrsqrtv movbe aesenc aesenclast aesdec aesdeclast aesimc aeskeygenassist vaesenc vaesenclast vaesdec vaesdeclast vaesimc vaeskeygenassist vaddpd vaddps vaddsd vaddss vaddsubpd vaddsubps vandpd vandps vandnpd vandnps vblendpd vblendps vblendvpd vblendvps vbroadcastss vbroadcastsd vbroadcastf128 vcmpeq_ospd vcmpeqpd vcmplt_ospd vcmpltpd vcmple_ospd vcmplepd vcmpunord_qpd vcmpunordpd vcmpneq_uqpd vcmpneqpd vcmpnlt_uspd vcmpnltpd vcmpnle_uspd vcmpnlepd vcmpord_qpd vcmpordpd vcmpeq_uqpd vcmpnge_uspd vcmpngepd vcmpngt_uspd vcmpngtpd vcmpfalse_oqpd vcmpfalsepd vcmpneq_oqpd vcmpge_ospd vcmpgepd vcmpgt_ospd vcmpgtpd vcmptrue_uqpd vcmptruepd vcmplt_oqpd vcmple_oqpd vcmpunord_spd vcmpneq_uspd vcmpnlt_uqpd vcmpnle_uqpd vcmpord_spd vcmpeq_uspd vcmpnge_uqpd vcmpngt_uqpd vcmpfalse_ospd vcmpneq_ospd vcmpge_oqpd vcmpgt_oqpd vcmptrue_uspd vcmppd vcmpeq_osps vcmpeqps vcmplt_osps vcmpltps vcmple_osps vcmpleps vcmpunord_qps vcmpunordps vcmpneq_uqps vcmpneqps vcmpnlt_usps vcmpnltps vcmpnle_usps vcmpnleps vcmpord_qps vcmpordps vcmpeq_uqps vcmpnge_usps vcmpngeps vcmpngt_usps vcmpngtps vcmpfalse_oqps vcmpfalseps vcmpneq_oqps vcmpge_osps vcmpgeps vcmpgt_osps vcmpgtps vcmptrue_uqps vcmptrueps vcmplt_oqps vcmple_oqps vcmpunord_sps vcmpneq_usps vcmpnlt_uqps vcmpnle_uqps vcmpord_sps vcmpeq_usps vcmpnge_uqps vcmpngt_uqps vcmpfalse_osps vcmpneq_osps vcmpge_oqps vcmpgt_oqps vcmptrue_usps vcmpps vcmpeq_ossd vcmpeqsd vcmplt_ossd vcmpltsd vcmple_ossd vcmplesd vcmpunord_qsd vcmpunordsd vcmpneq_uqsd vcmpneqsd vcmpnlt_ussd vcmpnltsd vcmpnle_ussd vcmpnlesd vcmpord_qsd vcmpordsd vcmpeq_uqsd vcmpnge_ussd vcmpngesd vcmpngt_ussd vcmpngtsd vcmpfalse_oqsd vcmpfalsesd vcmpneq_oqsd vcmpge_ossd vcmpgesd vcmpgt_ossd vcmpgtsd vcmptrue_uqsd vcmptruesd vcmplt_oqsd vcmple_oqsd vcmpunord_ssd vcmpneq_ussd vcmpnlt_uqsd vcmpnle_uqsd vcmpord_ssd vcmpeq_ussd vcmpnge_uqsd vcmpngt_uqsd vcmpfalse_ossd vcmpneq_ossd vcmpge_oqsd vcmpgt_oqsd vcmptrue_ussd vcmpsd vcmpeq_osss vcmpeqss vcmplt_osss vcmpltss vcmple_osss vcmpless vcmpunord_qss vcmpunordss vcmpneq_uqss vcmpneqss vcmpnlt_usss vcmpnltss vcmpnle_usss vcmpnless vcmpord_qss vcmpordss vcmpeq_uqss vcmpnge_usss vcmpngess vcmpngt_usss vcmpngtss vcmpfalse_oqss vcmpfalsess vcmpneq_oqss vcmpge_osss vcmpgess vcmpgt_osss vcmpgtss vcmptrue_uqss vcmptruess vcmplt_oqss vcmple_oqss vcmpunord_sss vcmpneq_usss vcmpnlt_uqss vcmpnle_uqss vcmpord_sss vcmpeq_usss vcmpnge_uqss vcmpngt_uqss vcmpfalse_osss vcmpneq_osss vcmpge_oqss vcmpgt_oqss vcmptrue_usss vcmpss vcomisd vcomiss vcvtdq2pd vcvtdq2ps vcvtpd2dq vcvtpd2ps vcvtps2dq vcvtps2pd vcvtsd2si vcvtsd2ss vcvtsi2sd vcvtsi2ss vcvtss2sd vcvtss2si vcvttpd2dq vcvttps2dq vcvttsd2si vcvttss2si vdivpd vdivps vdivsd vdivss vdppd vdpps vextractf128 vextractps vhaddpd vhaddps vhsubpd vhsubps vinsertf128 vinsertps vlddqu vldqqu vldmxcsr vmaskmovdqu vmaskmovps vmaskmovpd vmaxpd vmaxps vmaxsd vmaxss vminpd vminps vminsd vminss vmovapd vmovaps vmovd vmovq vmovddup vmovdqa vmovqqa vmovdqu vmovqqu vmovhlps vmovhpd vmovhps vmovlhps vmovlpd vmovlps vmovmskpd vmovmskps vmovntdq vmovntqq vmovntdqa vmovntpd vmovntps vmovsd vmovshdup vmovsldup vmovss vmovupd vmovups vmpsadbw vmulpd vmulps vmulsd vmulss vorpd vorps vpabsb vpabsw vpabsd vpacksswb vpackssdw vpackuswb vpackusdw vpaddb vpaddw vpaddd vpaddq vpaddsb vpaddsw vpaddusb vpaddusw vpalignr vpand vpandn vpavgb vpavgw vpblendvb vpblendw vpcmpestri vpcmpestrm vpcmpistri vpcmpistrm vpcmpeqb vpcmpeqw vpcmpeqd vpcmpeqq vpcmpgtb vpcmpgtw vpcmpgtd vpcmpgtq vpermilpd vpermilps vperm2f128 vpextrb vpextrw vpextrd vpextrq vphaddw vphaddd vphaddsw vphminposuw vphsubw vphsubd vphsubsw vpinsrb vpinsrw vpinsrd vpinsrq vpmaddwd vpmaddubsw vpmaxsb vpmaxsw vpmaxsd vpmaxub vpmaxuw vpmaxud vpminsb vpminsw vpminsd vpminub vpminuw vpminud vpmovmskb vpmovsxbw vpmovsxbd vpmovsxbq vpmovsxwd vpmovsxwq vpmovsxdq vpmovzxbw vpmovzxbd vpmovzxbq vpmovzxwd vpmovzxwq vpmovzxdq vpmulhuw vpmulhrsw vpmulhw vpmullw vpmulld vpmuludq vpmuldq vpor vpsadbw vpshufb vpshufd vpshufhw vpshuflw vpsignb vpsignw vpsignd vpslldq vpsrldq vpsllw vpslld vpsllq vpsraw vpsrad vpsrlw vpsrld vpsrlq vptest vpsubb vpsubw vpsubd vpsubq vpsubsb vpsubsw vpsubusb vpsubusw vpunpckhbw vpunpckhwd vpunpckhdq vpunpckhqdq vpunpcklbw vpunpcklwd vpunpckldq vpunpcklqdq vpxor vrcpps vrcpss vrsqrtps vrsqrtss vroundpd vroundps vroundsd vroundss vshufpd vshufps vsqrtpd vsqrtps vsqrtsd vsqrtss vstmxcsr vsubpd vsubps vsubsd vsubss vtestps vtestpd vucomisd vucomiss vunpckhpd vunpckhps vunpcklpd vunpcklps vxorpd vxorps vzeroall vzeroupper pclmullqlqdq pclmulhqlqdq pclmullqhqdq pclmulhqhqdq pclmulqdq vpclmullqlqdq vpclmulhqlqdq vpclmullqhqdq vpclmulhqhqdq vpclmulqdq vfmadd132ps vfmadd132pd vfmadd312ps vfmadd312pd vfmadd213ps vfmadd213pd vfmadd123ps vfmadd123pd vfmadd231ps vfmadd231pd vfmadd321ps vfmadd321pd vfmaddsub132ps vfmaddsub132pd vfmaddsub312ps vfmaddsub312pd vfmaddsub213ps vfmaddsub213pd vfmaddsub123ps vfmaddsub123pd vfmaddsub231ps vfmaddsub231pd vfmaddsub321ps vfmaddsub321pd vfmsub132ps vfmsub132pd vfmsub312ps vfmsub312pd vfmsub213ps vfmsub213pd vfmsub123ps vfmsub123pd vfmsub231ps vfmsub231pd vfmsub321ps vfmsub321pd vfmsubadd132ps vfmsubadd132pd vfmsubadd312ps vfmsubadd312pd vfmsubadd213ps vfmsubadd213pd vfmsubadd123ps vfmsubadd123pd vfmsubadd231ps vfmsubadd231pd vfmsubadd321ps vfmsubadd321pd vfnmadd132ps vfnmadd132pd vfnmadd312ps vfnmadd312pd vfnmadd213ps vfnmadd213pd vfnmadd123ps vfnmadd123pd vfnmadd231ps vfnmadd231pd vfnmadd321ps vfnmadd321pd vfnmsub132ps vfnmsub132pd vfnmsub312ps vfnmsub312pd vfnmsub213ps vfnmsub213pd vfnmsub123ps vfnmsub123pd vfnmsub231ps vfnmsub231pd vfnmsub321ps vfnmsub321pd vfmadd132ss vfmadd132sd vfmadd312ss vfmadd312sd vfmadd213ss vfmadd213sd vfmadd123ss vfmadd123sd vfmadd231ss vfmadd231sd vfmadd321ss vfmadd321sd vfmsub132ss vfmsub132sd vfmsub312ss vfmsub312sd vfmsub213ss vfmsub213sd vfmsub123ss vfmsub123sd vfmsub231ss vfmsub231sd vfmsub321ss vfmsub321sd vfnmadd132ss vfnmadd132sd vfnmadd312ss vfnmadd312sd vfnmadd213ss vfnmadd213sd vfnmadd123ss vfnmadd123sd vfnmadd231ss vfnmadd231sd vfnmadd321ss vfnmadd321sd vfnmsub132ss vfnmsub132sd vfnmsub312ss vfnmsub312sd vfnmsub213ss vfnmsub213sd vfnmsub123ss vfnmsub123sd vfnmsub231ss vfnmsub231sd vfnmsub321ss vfnmsub321sd rdfsbase rdgsbase rdrand wrfsbase wrgsbase vcvtph2ps vcvtps2ph adcx adox rdseed clac stac xstore xcryptecb xcryptcbc xcryptctr xcryptcfb xcryptofb montmul xsha1 xsha256 llwpcb slwpcb lwpval lwpins vfmaddpd vfmaddps vfmaddsd vfmaddss vfmaddsubpd vfmaddsubps vfmsubaddpd vfmsubaddps vfmsubpd vfmsubps vfmsubsd vfmsubss vfnmaddpd vfnmaddps vfnmaddsd vfnmaddss vfnmsubpd vfnmsubps vfnmsubsd vfnmsubss vfrczpd vfrczps vfrczsd vfrczss vpcmov vpcomb vpcomd vpcomq vpcomub vpcomud vpcomuq vpcomuw vpcomw vphaddbd vphaddbq vphaddbw vphadddq vphaddubd vphaddubq vphaddubw vphaddudq vphadduwd vphadduwq vphaddwd vphaddwq vphsubbw vphsubdq vphsubwd vpmacsdd vpmacsdqh vpmacsdql vpmacssdd vpmacssdqh vpmacssdql vpmacsswd vpmacssww vpmacswd vpmacsww vpmadcsswd vpmadcswd vpperm vprotb vprotd vprotq vprotw vpshab vpshad vpshaq vpshaw vpshlb vpshld vpshlq vpshlw vbroadcasti128 vpblendd vpbroadcastb vpbroadcastw vpbroadcastd vpbroadcastq vpermd vpermpd vpermps vpermq vperm2i128 vextracti128 vinserti128 vpmaskmovd vpmaskmovq vpsllvd vpsllvq vpsravd vpsrlvd vpsrlvq vgatherdpd vgatherqpd vgatherdps vgatherqps vpgatherdd vpgatherqd vpgatherdq vpgatherqq xabort xbegin xend xtest andn bextr blci blcic blsi blsic blcfill blsfill blcmsk blsmsk blsr blcs bzhi mulx pdep pext rorx sarx shlx shrx tzcnt tzmsk t1mskc valignd valignq vblendmpd vblendmps vbroadcastf32x4 vbroadcastf64x4 vbroadcasti32x4 vbroadcasti64x4 vcompresspd vcompressps vcvtpd2udq vcvtps2udq vcvtsd2usi vcvtss2usi vcvttpd2udq vcvttps2udq vcvttsd2usi vcvttss2usi vcvtudq2pd vcvtudq2ps vcvtusi2sd vcvtusi2ss vexpandpd vexpandps vextractf32x4 vextractf64x4 vextracti32x4 vextracti64x4 vfixupimmpd vfixupimmps vfixupimmsd vfixupimmss vgetexppd vgetexpps vgetexpsd vgetexpss vgetmantpd vgetmantps vgetmantsd vgetmantss vinsertf32x4 vinsertf64x4 vinserti32x4 vinserti64x4 vmovdqa32 vmovdqa64 vmovdqu32 vmovdqu64 vpabsq vpandd vpandnd vpandnq vpandq vpblendmd vpblendmq vpcmpltd vpcmpled vpcmpneqd vpcmpnltd vpcmpnled vpcmpd vpcmpltq vpcmpleq vpcmpneqq vpcmpnltq vpcmpnleq vpcmpq vpcmpequd vpcmpltud vpcmpleud vpcmpnequd vpcmpnltud vpcmpnleud vpcmpud vpcmpequq vpcmpltuq vpcmpleuq vpcmpnequq vpcmpnltuq vpcmpnleuq vpcmpuq vpcompressd vpcompressq vpermi2d vpermi2pd vpermi2ps vpermi2q vpermt2d vpermt2pd vpermt2ps vpermt2q vpexpandd vpexpandq vpmaxsq vpmaxuq vpminsq vpminuq vpmovdb vpmovdw vpmovqb vpmovqd vpmovqw vpmovsdb vpmovsdw vpmovsqb vpmovsqd vpmovsqw vpmovusdb vpmovusdw vpmovusqb vpmovusqd vpmovusqw vpord vporq vprold vprolq vprolvd vprolvq vprord vprorq vprorvd vprorvq vpscatterdd vpscatterdq vpscatterqd vpscatterqq vpsraq vpsravq vpternlogd vpternlogq vptestmd vptestmq vptestnmd vptestnmq vpxord vpxorq vrcp14pd vrcp14ps vrcp14sd vrcp14ss vrndscalepd vrndscaleps vrndscalesd vrndscaless vrsqrt14pd vrsqrt14ps vrsqrt14sd vrsqrt14ss vscalefpd vscalefps vscalefsd vscalefss vscatterdpd vscatterdps vscatterqpd vscatterqps vshuff32x4 vshuff64x2 vshufi32x4 vshufi64x2 kandnw kandw kmovw knotw kortestw korw kshiftlw kshiftrw kunpckbw kxnorw kxorw vpbroadcastmb2q vpbroadcastmw2d vpconflictd vpconflictq vplzcntd vplzcntq vexp2pd vexp2ps vrcp28pd vrcp28ps vrcp28sd vrcp28ss vrsqrt28pd vrsqrt28ps vrsqrt28sd vrsqrt28ss vgatherpf0dpd vgatherpf0dps vgatherpf0qpd vgatherpf0qps vgatherpf1dpd vgatherpf1dps vgatherpf1qpd vgatherpf1qps vscatterpf0dpd vscatterpf0dps vscatterpf0qpd vscatterpf0qps vscatterpf1dpd vscatterpf1dps vscatterpf1qpd vscatterpf1qps prefetchwt1 bndmk bndcl bndcu bndcn bndmov bndldx bndstx sha1rnds4 sha1nexte sha1msg1 sha1msg2 sha256rnds2 sha256msg1 sha256msg2 hint_nop0 hint_nop1 hint_nop2 hint_nop3 hint_nop4 hint_nop5 hint_nop6 hint_nop7 hint_nop8 hint_nop9 hint_nop10 hint_nop11 hint_nop12 hint_nop13 hint_nop14 hint_nop15 hint_nop16 hint_nop17 hint_nop18 hint_nop19 hint_nop20 hint_nop21 hint_nop22 hint_nop23 hint_nop24 hint_nop25 hint_nop26 hint_nop27 hint_nop28 hint_nop29 hint_nop30 hint_nop31 hint_nop32 hint_nop33 hint_nop34 hint_nop35 hint_nop36 hint_nop37 hint_nop38 hint_nop39 hint_nop40 hint_nop41 hint_nop42 hint_nop43 hint_nop44 hint_nop45 hint_nop46 hint_nop47 hint_nop48 hint_nop49 hint_nop50 hint_nop51 hint_nop52 hint_nop53 hint_nop54 hint_nop55 hint_nop56 hint_nop57 hint_nop58 hint_nop59 hint_nop60 hint_nop61 hint_nop62 hint_nop63',
        built_in:
          // Instruction pointer
          'ip eip rip ' +
          // 8-bit registers
          'al ah bl bh cl ch dl dh sil dil bpl spl r8b r9b r10b r11b r12b r13b r14b r15b ' +
          // 16-bit registers
          'ax bx cx dx si di bp sp r8w r9w r10w r11w r12w r13w r14w r15w ' +
          // 32-bit registers
          'eax ebx ecx edx esi edi ebp esp eip r8d r9d r10d r11d r12d r13d r14d r15d ' +
          // 64-bit registers
          'rax rbx rcx rdx rsi rdi rbp rsp r8 r9 r10 r11 r12 r13 r14 r15 ' +
          // Segment registers
          'cs ds es fs gs ss ' +
          // Floating point stack registers
          'st st0 st1 st2 st3 st4 st5 st6 st7 ' +
          // MMX Registers
          'mm0 mm1 mm2 mm3 mm4 mm5 mm6 mm7 ' +
          // SSE registers
          'xmm0  xmm1  xmm2  xmm3  xmm4  xmm5  xmm6  xmm7  xmm8  xmm9 xmm10  xmm11 xmm12 xmm13 xmm14 xmm15 ' +
          'xmm16 xmm17 xmm18 xmm19 xmm20 xmm21 xmm22 xmm23 xmm24 xmm25 xmm26 xmm27 xmm28 xmm29 xmm30 xmm31 ' +
          // AVX registers
          'ymm0  ymm1  ymm2  ymm3  ymm4  ymm5  ymm6  ymm7  ymm8  ymm9 ymm10  ymm11 ymm12 ymm13 ymm14 ymm15 ' +
          'ymm16 ymm17 ymm18 ymm19 ymm20 ymm21 ymm22 ymm23 ymm24 ymm25 ymm26 ymm27 ymm28 ymm29 ymm30 ymm31 ' +
          // AVX-512F registers
          'zmm0  zmm1  zmm2  zmm3  zmm4  zmm5  zmm6  zmm7  zmm8  zmm9 zmm10  zmm11 zmm12 zmm13 zmm14 zmm15 ' +
          'zmm16 zmm17 zmm18 zmm19 zmm20 zmm21 zmm22 zmm23 zmm24 zmm25 zmm26 zmm27 zmm28 zmm29 zmm30 zmm31 ' +
          // AVX-512F mask registers
          'k0 k1 k2 k3 k4 k5 k6 k7 ' +
          // Bound (MPX) register
          'bnd0 bnd1 bnd2 bnd3 ' +
          // Special register
          'cr0 cr1 cr2 cr3 cr4 cr8 dr0 dr1 dr2 dr3 dr8 tr3 tr4 tr5 tr6 tr7 ' +
          // NASM altreg package
          'r0 r1 r2 r3 r4 r5 r6 r7 r0b r1b r2b r3b r4b r5b r6b r7b ' +
          'r0w r1w r2w r3w r4w r5w r6w r7w r0d r1d r2d r3d r4d r5d r6d r7d ' +
          'r0h r1h r2h r3h ' +
          'r0l r1l r2l r3l r4l r5l r6l r7l r8l r9l r10l r11l r12l r13l r14l r15l ' +

          'db dw dd dq dt ddq do dy dz ' +
          'resb resw resd resq rest resdq reso resy resz ' +
          'incbin equ times ' +
          'byte word dword qword nosplit rel abs seg wrt strict near far a32 ptr',

        meta:
          '%define %xdefine %+ %undef %defstr %deftok %assign %strcat %strlen %substr %rotate %elif %else %endif ' +
          '%if %ifmacro %ifctx %ifidn %ifidni %ifid %ifnum %ifstr %iftoken %ifempty %ifenv %error %warning %fatal %rep ' +
          '%endrep %include %push %pop %repl %pathsearch %depend %use %arg %stacksize %local %line %comment %endcomment ' +
          '.nolist ' +
          '__FILE__ __LINE__ __SECT__  __BITS__ __OUTPUT_FORMAT__ __DATE__ __TIME__ __DATE_NUM__ __TIME_NUM__ ' +
          '__UTC_DATE__ __UTC_TIME__ __UTC_DATE_NUM__ __UTC_TIME_NUM__  __PASS__ struc endstruc istruc at iend ' +
          'align alignb sectalign daz nodaz up down zero default option assume public ' +

          'bits use16 use32 use64 default section segment absolute extern global common cpu float ' +
          '__utf16__ __utf16le__ __utf16be__ __utf32__ __utf32le__ __utf32be__ ' +
          '__float8__ __float16__ __float32__ __float64__ __float80m__ __float80e__ __float128l__ __float128h__ ' +
          '__Infinity__ __QNaN__ __SNaN__ Inf NaN QNaN SNaN float8 float16 float32 float64 float80m float80e ' +
          'float128l float128h __FLOAT_DAZ__ __FLOAT_ROUND__ __FLOAT__'
      },
      contains: [
        hljs.COMMENT(
          ';',
          '$',
          {
            relevance: 0
          }
        ),
        {
          className: 'number',
          variants: [
            // Float number and x87 BCD
            {
              begin: '\\b(?:([0-9][0-9_]*)?\\.[0-9_]*(?:[eE][+-]?[0-9_]+)?|' +
                     '(0[Xx])?[0-9][0-9_]*\\.?[0-9_]*(?:[pP](?:[+-]?[0-9_]+)?)?)\\b',
              relevance: 0
            },

            // Hex number in $
            { begin: '\\$[0-9][0-9A-Fa-f]*', relevance: 0 },

            // Number in H,D,T,Q,O,B,Y suffix
            { begin: '\\b(?:[0-9A-Fa-f][0-9A-Fa-f_]*[Hh]|[0-9][0-9_]*[DdTt]?|[0-7][0-7_]*[QqOo]|[0-1][0-1_]*[BbYy])\\b' },

            // Number in X,D,T,Q,O,B,Y prefix
            { begin: '\\b(?:0[Xx][0-9A-Fa-f_]+|0[DdTt][0-9_]+|0[QqOo][0-7_]+|0[BbYy][0-1_]+)\\b'}
          ]
        },
        // Double quote string
        hljs.QUOTE_STRING_MODE,
        {
          className: 'string',
          variants: [
            // Single-quoted string
            { begin: '\'', end: '[^\\\\]\'' },
            // Backquoted string
            { begin: '`', end: '[^\\\\]`' }
          ],
          relevance: 0
        },
        {
          className: 'symbol',
          variants: [
            // Global label and local label
            { begin: '^\\s*[A-Za-z._?][A-Za-z0-9_$#@~.?]*(:|\\s+label)' },
            // Macro-local label
            { begin: '^\\s*%%[A-Za-z0-9_$#@~.?]*:' }
          ],
          relevance: 0
        },
        // Macro parameter
        {
          className: 'subst',
          begin: '%[0-9]+',
          relevance: 0
        },
        // Macro parameter
        {
          className: 'subst',
          begin: '%!\S+',
          relevance: 0
        },
        {
          className: 'meta',
          begin: /^\s*\.[\w_-]+/
        }
      ]
    };
  }

  return x86asm;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('csharp', function () {
  'use strict';

  /*
  Language: C#
  Author: Jason Diamond <jason@diamond.name>
  Contributor: Nicolas LLOBERA <nllobera@gmail.com>, Pieter Vantorre <pietervantorre@gmail.com>, David Pine <david.pine@microsoft.com>
  Website: https://docs.microsoft.com/en-us/dotnet/csharp/
  Category: common
  */

  /** @type LanguageFn */
  function csharp(hljs) {
    var BUILT_IN_KEYWORDS = [
        'bool',
        'byte',
        'char',
        'decimal',
        'delegate',
        'double',
        'dynamic',
        'enum',
        'float',
        'int',
        'long',
        'nint',
        'nuint',
        'object',
        'sbyte',
        'short',
        'string',
        'ulong',
        'unit',
        'ushort'
    ];
    var FUNCTION_MODIFIERS = [
      'public',
      'private',
      'protected',
      'static',
      'internal',
      'protected',
      'abstract',
      'async',
      'extern',
      'override',
      'unsafe',
      'virtual',
      'new',
      'sealed',
      'partial'
    ];
    var LITERAL_KEYWORDS = [
        'default',
        'false',
        'null',
        'true'
    ];
    var NORMAL_KEYWORDS = [
      'abstract',
      'as',
      'base',
      'break',
      'case',
      'class',
      'const',
      'continue',
      'do',
      'else',
      'event',
      'explicit',
      'extern',
      'finally',
      'fixed',
      'for',
      'foreach',
      'goto',
      'if',
      'implicit',
      'in',
      'interface',
      'internal',
      'is',
      'lock',
      'namespace',
      'new',
      'operator',
      'out',
      'override',
      'params',
      'private',
      'protected',
      'public',
      'readonly',
      'record',
      'ref',
      'return',
      'sealed',
      'sizeof',
      'stackalloc',
      'static',
      'struct',
      'switch',
      'this',
      'throw',
      'try',
      'typeof',
      'unchecked',
      'unsafe',
      'using',
      'virtual',
      'void',
      'volatile',
      'while'
    ];
    var CONTEXTUAL_KEYWORDS = [
      'add',
      'alias',
      'and',
      'ascending',
      'async',
      'await',
      'by',
      'descending',
      'equals',
      'from',
      'get',
      'global',
      'group',
      'init',
      'into',
      'join',
      'let',
      'nameof',
      'not',
      'notnull',
      'on',
      'or',
      'orderby',
      'partial',
      'remove',
      'select',
      'set',
      'unmanaged',
      'value',
      'var',
      'when',
      'where',
      'with',
      'yield'
    ];

    var KEYWORDS = {
      keyword: NORMAL_KEYWORDS.concat(CONTEXTUAL_KEYWORDS).join(' '),
      built_in: BUILT_IN_KEYWORDS.join(' '),
      literal: LITERAL_KEYWORDS.join(' ')
    };
    var TITLE_MODE = hljs.inherit(hljs.TITLE_MODE, {begin: '[a-zA-Z](\\.?\\w)*'});
    var NUMBERS = {
      className: 'number',
      variants: [
        { begin: '\\b(0b[01\']+)' },
        { begin: '(-?)\\b([\\d\']+(\\.[\\d\']*)?|\\.[\\d\']+)(u|U|l|L|ul|UL|f|F|b|B)' },
        { begin: '(-?)(\\b0[xX][a-fA-F0-9\']+|(\\b[\\d\']+(\\.[\\d\']*)?|\\.[\\d\']+)([eE][-+]?[\\d\']+)?)' }
      ],
      relevance: 0
    };
    var VERBATIM_STRING = {
      className: 'string',
      begin: '@"', end: '"',
      contains: [{begin: '""'}]
    };
    var VERBATIM_STRING_NO_LF = hljs.inherit(VERBATIM_STRING, {illegal: /\n/});
    var SUBST = {
      className: 'subst',
      begin: '{', end: '}',
      keywords: KEYWORDS
    };
    var SUBST_NO_LF = hljs.inherit(SUBST, {illegal: /\n/});
    var INTERPOLATED_STRING = {
      className: 'string',
      begin: /\$"/, end: '"',
      illegal: /\n/,
      contains: [{begin: '{{'}, {begin: '}}'}, hljs.BACKSLASH_ESCAPE, SUBST_NO_LF]
    };
    var INTERPOLATED_VERBATIM_STRING = {
      className: 'string',
      begin: /\$@"/, end: '"',
      contains: [{begin: '{{'}, {begin: '}}'}, {begin: '""'}, SUBST]
    };
    var INTERPOLATED_VERBATIM_STRING_NO_LF = hljs.inherit(INTERPOLATED_VERBATIM_STRING, {
      illegal: /\n/,
      contains: [{begin: '{{'}, {begin: '}}'}, {begin: '""'}, SUBST_NO_LF]
    });
    SUBST.contains = [
      INTERPOLATED_VERBATIM_STRING,
      INTERPOLATED_STRING,
      VERBATIM_STRING,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      NUMBERS,
      hljs.C_BLOCK_COMMENT_MODE
    ];
    SUBST_NO_LF.contains = [
      INTERPOLATED_VERBATIM_STRING_NO_LF,
      INTERPOLATED_STRING,
      VERBATIM_STRING_NO_LF,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      NUMBERS,
      hljs.inherit(hljs.C_BLOCK_COMMENT_MODE, {illegal: /\n/})
    ];
    var STRING = {
      variants: [
        INTERPOLATED_VERBATIM_STRING,
        INTERPOLATED_STRING,
        VERBATIM_STRING,
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ]
    };

    var GENERIC_MODIFIER = {
      begin: "<",
      end: ">",
      contains: [
        { beginKeywords: "in out"},
        TITLE_MODE
      ]
    };
    var TYPE_IDENT_RE = hljs.IDENT_RE + '(<' + hljs.IDENT_RE + '(\\s*,\\s*' + hljs.IDENT_RE + ')*>)?(\\[\\])?';
    var AT_IDENTIFIER = {
      // prevents expressions like `@class` from incorrect flagging
      // `class` as a keyword
      begin: "@" + hljs.IDENT_RE,
      relevance: 0
    };

    return {
      name: 'C#',
      aliases: ['cs', 'c#'],
      keywords: KEYWORDS,
      illegal: /::/,
      contains: [
        hljs.COMMENT(
          '///',
          '$',
          {
            returnBegin: true,
            contains: [
              {
                className: 'doctag',
                variants: [
                  {
                    begin: '///', relevance: 0
                  },
                  {
                    begin: '<!--|-->'
                  },
                  {
                    begin: '</?', end: '>'
                  }
                ]
              }
            ]
          }
        ),
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        {
          className: 'meta',
          begin: '#', end: '$',
          keywords: {
            'meta-keyword': 'if else elif endif define undef warning error line region endregion pragma checksum'
          }
        },
        STRING,
        NUMBERS,
        {
          beginKeywords: 'class interface', end: /[{;=]/,
          illegal: /[^\s:,]/,
          contains: [
            { beginKeywords: "where class" },
            TITLE_MODE,
            GENERIC_MODIFIER,
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE
          ]
        },
        {
          beginKeywords: 'namespace', end: /[{;=]/,
          illegal: /[^\s:]/,
          contains: [
            TITLE_MODE,
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE
          ]
        },
        {
          beginKeywords: 'record', end: /[{;=]/,
          illegal: /[^\s:]/,
          contains: [
            TITLE_MODE,
            GENERIC_MODIFIER,
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE
          ]
        },
        {
          // [Attributes("")]
          className: 'meta',
          begin: '^\\s*\\[', excludeBegin: true, end: '\\]', excludeEnd: true,
          contains: [
            {className: 'meta-string', begin: /"/, end: /"/}
          ]
        },
        {
          // Expression keywords prevent 'keyword Name(...)' from being
          // recognized as a function definition
          beginKeywords: 'new return throw await else',
          relevance: 0
        },
        {
          className: 'function',
          begin: '(' + TYPE_IDENT_RE + '\\s+)+' + hljs.IDENT_RE + '\\s*(\\<.+\\>)?\\s*\\(', returnBegin: true,
          end: /\s*[{;=]/, excludeEnd: true,
          keywords: KEYWORDS,
          contains: [
            // prevents these from being highlighted `title`
            { beginKeywords: FUNCTION_MODIFIERS.join(" ")},
            {
              begin: hljs.IDENT_RE + '\\s*(\\<.+\\>)?\\s*\\(', returnBegin: true,
              contains: [
                hljs.TITLE_MODE,
                GENERIC_MODIFIER
              ],
              relevance: 0
            },
            {
              className: 'params',
              begin: /\(/, end: /\)/,
              excludeBegin: true,
              excludeEnd: true,
              keywords: KEYWORDS,
              relevance: 0,
              contains: [
                STRING,
                NUMBERS,
                hljs.C_BLOCK_COMMENT_MODE
              ]
            },
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE
          ]
        },
        AT_IDENTIFIER
      ]
    };
  }

  return csharp;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('java', function () {
  'use strict';

  /**
   * @param {string} value
   * @returns {RegExp}
   * */

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function source(re) {
    if (!re) return null;
    if (typeof re === "string") return re;

    return re.source;
  }

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function optional(re) {
    return concat('(', re, ')?');
  }

  /**
   * @param {...(RegExp | string) } args
   * @returns {string}
   */
  function concat(...args) {
    const joined = args.map((x) => source(x)).join("");
    return joined;
  }

  /**
   * Any of the passed expresssions may match
   *
   * Creates a huge this | this | that | that match
   * @param {(RegExp | string)[] } args
   * @returns {string}
   */
  function either(...args) {
    const joined = '(' + args.map((x) => source(x)).join("|") + ")";
    return joined;
  }

  /*
  Language: Java
  Author: Vsevolod Solovyov <vsevolod.solovyov@gmail.com>
  Category: common, enterprise
  Website: https://www.java.com/
  */

  function java(hljs) {
    var JAVA_IDENT_RE = '[\u00C0-\u02B8a-zA-Z_$][\u00C0-\u02B8a-zA-Z_$0-9]*';
    var GENERIC_IDENT_RE = JAVA_IDENT_RE + '(<' + JAVA_IDENT_RE + '(\\s*,\\s*' + JAVA_IDENT_RE + ')*>)?';
    var KEYWORDS = 'false synchronized int abstract float private char boolean var static null if const ' +
      'for true while long strictfp finally protected import native final void ' +
      'enum else break transient catch instanceof byte super volatile case assert short ' +
      'package default double public try this switch continue throws protected public private ' +
      'module requires exports do';

    var ANNOTATION = {
      className: 'meta',
      begin: '@' + JAVA_IDENT_RE,
      contains: [
        {
          begin: /\(/,
          end: /\)/,
          contains: ["self"] // allow nested () inside our annotation
        },
      ]
    };
    /**
     * A given sequence, possibly with underscores
     * @type {(s: string | RegExp) => string}  */
    var SEQUENCE_ALLOWING_UNDERSCORES = (seq) => concat('[', seq, ']+([', seq, '_]*[', seq, ']+)?');
    var JAVA_NUMBER_MODE = {
      className: 'number',
      variants: [
        { begin: `\\b(0[bB]${SEQUENCE_ALLOWING_UNDERSCORES('01')})[lL]?` }, // binary
        { begin: `\\b(0${SEQUENCE_ALLOWING_UNDERSCORES('0-7')})[dDfFlL]?` }, // octal
        {
          begin: concat(
            /\b0[xX]/,
            either(
              concat(SEQUENCE_ALLOWING_UNDERSCORES('a-fA-F0-9'), /\./, SEQUENCE_ALLOWING_UNDERSCORES('a-fA-F0-9')),
              concat(SEQUENCE_ALLOWING_UNDERSCORES('a-fA-F0-9'), /\.?/),
              concat(/\./, SEQUENCE_ALLOWING_UNDERSCORES('a-fA-F0-9'))
            ),
            /([pP][+-]?(\d+))?/,
            /[fFdDlL]?/ // decimal & fp mixed for simplicity
          )
        },
        // scientific notation
        { begin: concat(
          /\b/,
          either(
            concat(/\d*\./, SEQUENCE_ALLOWING_UNDERSCORES("\\d")), // .3, 3.3, 3.3_3
            SEQUENCE_ALLOWING_UNDERSCORES("\\d") // 3, 3_3
          ),
          /[eE][+-]?[\d]+[dDfF]?/)
        },
        // decimal & fp mixed for simplicity
        { begin: concat(
          /\b/,
          SEQUENCE_ALLOWING_UNDERSCORES(/\d/),
          optional(/\.?/),
          optional(SEQUENCE_ALLOWING_UNDERSCORES(/\d/)),
          /[dDfFlL]?/)
        }
      ],
      relevance: 0
    };

    return {
      name: 'Java',
      aliases: ['jsp'],
      keywords: KEYWORDS,
      illegal: /<\/|#/,
      contains: [
        hljs.COMMENT(
          '/\\*\\*',
          '\\*/',
          {
            relevance: 0,
            contains: [
              {
                // eat up @'s in emails to prevent them to be recognized as doctags
                begin: /\w+@/, relevance: 0
              },
              {
                className: 'doctag',
                begin: '@[A-Za-z]+'
              }
            ]
          }
        ),
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        {
          className: 'class',
          beginKeywords: 'class interface enum', end: /[{;=]/, excludeEnd: true,
          keywords: 'class interface enum',
          illegal: /[:"\[\]]/,
          contains: [
            { beginKeywords: 'extends implements' },
            hljs.UNDERSCORE_TITLE_MODE
          ]
        },
        {
          // Expression keywords prevent 'keyword Name(...)' from being
          // recognized as a function definition
          beginKeywords: 'new throw return else',
          relevance: 0
        },
        {
          className: 'class',
          begin: 'record\\s+' + hljs.UNDERSCORE_IDENT_RE + '\\s*\\(',
          returnBegin: true,
          excludeEnd: true,
          end: /[{;=]/,
          keywords: KEYWORDS,
          contains: [
            { beginKeywords: "record" },
            {
              begin: hljs.UNDERSCORE_IDENT_RE + '\\s*\\(',
              returnBegin: true,
              relevance: 0,
              contains: [hljs.UNDERSCORE_TITLE_MODE]
            },
            {
              className: 'params',
              begin: /\(/, end: /\)/,
              keywords: KEYWORDS,
              relevance: 0,
              contains: [
                hljs.C_BLOCK_COMMENT_MODE
              ]
            },
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE
          ]
        },
        {
          className: 'function',
          begin: '(' + GENERIC_IDENT_RE + '\\s+)+' + hljs.UNDERSCORE_IDENT_RE + '\\s*\\(', returnBegin: true, end: /[{;=]/,
          excludeEnd: true,
          keywords: KEYWORDS,
          contains: [
            {
              begin: hljs.UNDERSCORE_IDENT_RE + '\\s*\\(', returnBegin: true,
              relevance: 0,
              contains: [hljs.UNDERSCORE_TITLE_MODE]
            },
            {
              className: 'params',
              begin: /\(/, end: /\)/,
              keywords: KEYWORDS,
              relevance: 0,
              contains: [
                ANNOTATION,
                hljs.APOS_STRING_MODE,
                hljs.QUOTE_STRING_MODE,
                hljs.C_NUMBER_MODE,
                hljs.C_BLOCK_COMMENT_MODE
              ]
            },
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE
          ]
        },
        JAVA_NUMBER_MODE,
        ANNOTATION
      ]
    };
  }

  return java;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('bash', function () {
  'use strict';

  /*
  Language: Bash
  Author: vah <vahtenberg@gmail.com>
  Contributrors: Benjamin Pannell <contact@sierrasoftworks.com>
  Website: https://www.gnu.org/software/bash/
  Category: common
  */

  /** @type LanguageFn */
  function bash(hljs) {
    const VAR = {};
    const BRACED_VAR = {
      begin: /\$\{/,
      end:/\}/,
      contains: [
        "self",
        {
          begin: /:-/,
          contains: [ VAR ]
        } // default values
      ]
    };
    Object.assign(VAR,{
      className: 'variable',
      variants: [
        {begin: /\$[\w\d#@][\w\d_]*/},
        BRACED_VAR
      ]
    });

    const SUBST = {
      className: 'subst',
      begin: /\$\(/, end: /\)/,
      contains: [hljs.BACKSLASH_ESCAPE]
    };
    const HERE_DOC = {
      begin: /<<-?\s*(?=\w+)/,
      starts: {
        contains: [
          hljs.END_SAME_AS_BEGIN({
            begin: /(\w+)/,
            end: /(\w+)/,
            className: 'string'
          })
        ]
      }
    };
    const QUOTE_STRING = {
      className: 'string',
      begin: /"/, end: /"/,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        VAR,
        SUBST
      ]
    };
    SUBST.contains.push(QUOTE_STRING);
    const ESCAPED_QUOTE = {
      className: '',
      begin: /\\"/

    };
    const APOS_STRING = {
      className: 'string',
      begin: /'/, end: /'/
    };
    const ARITHMETIC = {
      begin: /\$\(\(/,
      end: /\)\)/,
      contains: [
        { begin: /\d+#[0-9a-f]+/, className: "number" },
        hljs.NUMBER_MODE,
        VAR
      ]
    };
    const SH_LIKE_SHELLS = [
      "fish",
      "bash",
      "zsh",
      "sh",
      "csh",
      "ksh",
      "tcsh",
      "dash",
      "scsh",
    ];
    const KNOWN_SHEBANG = hljs.SHEBANG({
      binary: `(${SH_LIKE_SHELLS.join("|")})`,
      relevance: 10
    });
    const FUNCTION = {
      className: 'function',
      begin: /\w[\w\d_]*\s*\(\s*\)\s*\{/,
      returnBegin: true,
      contains: [hljs.inherit(hljs.TITLE_MODE, {begin: /\w[\w\d_]*/})],
      relevance: 0
    };

    return {
      name: 'Bash',
      aliases: ['sh', 'zsh'],
      keywords: {
        $pattern: /\b[a-z._-]+\b/,
        keyword:
          'if then else elif fi for while in do done case esac function',
        literal:
          'true false',
        built_in:
          // Shell built-ins
          // http://www.gnu.org/software/bash/manual/html_node/Shell-Builtin-Commands.html
          'break cd continue eval exec exit export getopts hash pwd readonly return shift test times ' +
          'trap umask unset ' +
          // Bash built-ins
          'alias bind builtin caller command declare echo enable help let local logout mapfile printf ' +
          'read readarray source type typeset ulimit unalias ' +
          // Shell modifiers
          'set shopt ' +
          // Zsh built-ins
          'autoload bg bindkey bye cap chdir clone comparguments compcall compctl compdescribe compfiles ' +
          'compgroups compquote comptags comptry compvalues dirs disable disown echotc echoti emulate ' +
          'fc fg float functions getcap getln history integer jobs kill limit log noglob popd print ' +
          'pushd pushln rehash sched setcap setopt stat suspend ttyctl unfunction unhash unlimit ' +
          'unsetopt vared wait whence where which zcompile zformat zftp zle zmodload zparseopts zprof ' +
          'zpty zregexparse zsocket zstyle ztcp'
      },
      contains: [
        KNOWN_SHEBANG, // to catch known shells and boost relevancy
        hljs.SHEBANG(), // to catch unknown shells but still highlight the shebang
        FUNCTION,
        ARITHMETIC,
        hljs.HASH_COMMENT_MODE,
        HERE_DOC,
        QUOTE_STRING,
        ESCAPED_QUOTE,
        APOS_STRING,
        VAR
      ]
    };
  }

  return bash;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('c-like', function () {
  'use strict';

  /*
  Language: C-like foundation grammar for C/C++ grammars
  Author: Ivan Sagalaev <maniac@softwaremaniacs.org>
  Contributors: Evgeny Stepanischev <imbolk@gmail.com>, Zaven Muradyan <megalivoithos@gmail.com>, Roel Deckers <admin@codingcat.nl>, Sam Wu <samsam2310@gmail.com>, Jordi Petit <jordi.petit@gmail.com>, Pieter Vantorre <pietervantorre@gmail.com>, Google Inc. (David Benjamin) <davidben@google.com>
  Category: common, system
  */

  /* In the future the intention is to split out the C/C++ grammars distinctly
  since they are separate languages.  They will likely share a common foundation
  though, and this file sets the groundwork for that - so that we get the breaking
  change in v10 and don't have to change the requirements again later.

  See: https://github.com/highlightjs/highlight.js/issues/2146
  */

  /** @type LanguageFn */
  function cLike(hljs) {
    function optional(s) {
      return '(?:' + s + ')?';
    }
    // added for historic reasons because `hljs.C_LINE_COMMENT_MODE` does 
    // not include such support nor can we be sure all the grammars depending
    // on it would desire this behavior
    var C_LINE_COMMENT_MODE = hljs.COMMENT('//', '$', {
      contains: [{begin: /\\\n/}]
    });
    var DECLTYPE_AUTO_RE = 'decltype\\(auto\\)';
    var NAMESPACE_RE = '[a-zA-Z_]\\w*::';
    var TEMPLATE_ARGUMENT_RE = '<.*?>';
    var FUNCTION_TYPE_RE = '(' +
      DECLTYPE_AUTO_RE + '|' +
      optional(NAMESPACE_RE) +'[a-zA-Z_]\\w*' + optional(TEMPLATE_ARGUMENT_RE) +
    ')';
    var CPP_PRIMITIVE_TYPES = {
      className: 'keyword',
      begin: '\\b[a-z\\d_]*_t\\b'
    };

    // https://en.cppreference.com/w/cpp/language/escape
    // \\ \x \xFF \u2837 \u00323747 \374
    var CHARACTER_ESCAPES = '\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)';
    var STRINGS = {
      className: 'string',
      variants: [
        {
          begin: '(u8?|U|L)?"', end: '"',
          illegal: '\\n',
          contains: [hljs.BACKSLASH_ESCAPE]
        },
        {
          begin: '(u8?|U|L)?\'(' + CHARACTER_ESCAPES + "|.)", end: '\'',
          illegal: '.'
        },
        hljs.END_SAME_AS_BEGIN({
          begin: /(?:u8?|U|L)?R"([^()\\ ]{0,16})\(/,
          end: /\)([^()\\ ]{0,16})"/,
        })
      ]
    };

    var NUMBERS = {
      className: 'number',
      variants: [
        { begin: '\\b(0b[01\']+)' },
        { begin: '(-?)\\b([\\d\']+(\\.[\\d\']*)?|\\.[\\d\']+)(u|U|l|L|ul|UL|f|F|b|B)' },
        { begin: '(-?)(\\b0[xX][a-fA-F0-9\']+|(\\b[\\d\']+(\\.[\\d\']*)?|\\.[\\d\']+)([eE][-+]?[\\d\']+)?)' }
      ],
      relevance: 0
    };

    var PREPROCESSOR =       {
      className: 'meta',
      begin: /#\s*[a-z]+\b/, end: /$/,
      keywords: {
        'meta-keyword':
          'if else elif endif define undef warning error line ' +
          'pragma _Pragma ifdef ifndef include'
      },
      contains: [
        {
          begin: /\\\n/, relevance: 0
        },
        hljs.inherit(STRINGS, {className: 'meta-string'}),
        {
          className: 'meta-string',
          begin: /<.*?>/, end: /$/,
          illegal: '\\n',
        },
        C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE
      ]
    };

    var TITLE_MODE = {
      className: 'title',
      begin: optional(NAMESPACE_RE) + hljs.IDENT_RE,
      relevance: 0
    };

    var FUNCTION_TITLE = optional(NAMESPACE_RE) + hljs.IDENT_RE + '\\s*\\(';

    var CPP_KEYWORDS = {
      keyword: 'int float while private char char8_t char16_t char32_t catch import module export virtual operator sizeof ' +
        'dynamic_cast|10 typedef const_cast|10 const for static_cast|10 union namespace ' +
        'unsigned long volatile static protected bool template mutable if public friend ' +
        'do goto auto void enum else break extern using asm case typeid wchar_t ' +
        'short reinterpret_cast|10 default double register explicit signed typename try this ' +
        'switch continue inline delete alignas alignof constexpr consteval constinit decltype ' +
        'concept co_await co_return co_yield requires ' +
        'noexcept static_assert thread_local restrict final override ' +
        'atomic_bool atomic_char atomic_schar ' +
        'atomic_uchar atomic_short atomic_ushort atomic_int atomic_uint atomic_long atomic_ulong atomic_llong ' +
        'atomic_ullong new throw return ' +
        'and and_eq bitand bitor compl not not_eq or or_eq xor xor_eq',
      built_in: 'std string wstring cin cout cerr clog stdin stdout stderr stringstream istringstream ostringstream ' +
        'auto_ptr deque list queue stack vector map set pair bitset multiset multimap unordered_set ' +
        'unordered_map unordered_multiset unordered_multimap priority_queue make_pair array shared_ptr abort terminate abs acos ' +
        'asin atan2 atan calloc ceil cosh cos exit exp fabs floor fmod fprintf fputs free frexp ' +
        'fscanf future isalnum isalpha iscntrl isdigit isgraph islower isprint ispunct isspace isupper ' +
        'isxdigit tolower toupper labs ldexp log10 log malloc realloc memchr memcmp memcpy memset modf pow ' +
        'printf putchar puts scanf sinh sin snprintf sprintf sqrt sscanf strcat strchr strcmp ' +
        'strcpy strcspn strlen strncat strncmp strncpy strpbrk strrchr strspn strstr tanh tan ' +
        'vfprintf vprintf vsprintf endl initializer_list unique_ptr _Bool complex _Complex imaginary _Imaginary',
      literal: 'true false nullptr NULL'
    };

    var EXPRESSION_CONTAINS = [
      PREPROCESSOR,
      CPP_PRIMITIVE_TYPES,
      C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      NUMBERS,
      STRINGS
    ];

    var EXPRESSION_CONTEXT = {
      // This mode covers expression context where we can't expect a function
      // definition and shouldn't highlight anything that looks like one:
      // `return some()`, `else if()`, `(x*sum(1, 2))`
      variants: [
        {begin: /=/, end: /;/},
        {begin: /\(/, end: /\)/},
        {beginKeywords: 'new throw return else', end: /;/}
      ],
      keywords: CPP_KEYWORDS,
      contains: EXPRESSION_CONTAINS.concat([
        {
          begin: /\(/, end: /\)/,
          keywords: CPP_KEYWORDS,
          contains: EXPRESSION_CONTAINS.concat(['self']),
          relevance: 0
        }
      ]),
      relevance: 0
    };

    var FUNCTION_DECLARATION = {
      className: 'function',
      begin: '(' + FUNCTION_TYPE_RE + '[\\*&\\s]+)+' + FUNCTION_TITLE,
      returnBegin: true, end: /[{;=]/,
      excludeEnd: true,
      keywords: CPP_KEYWORDS,
      illegal: /[^\w\s\*&:<>]/,
      contains: [

        { // to prevent it from being confused as the function title
          begin: DECLTYPE_AUTO_RE,
          keywords: CPP_KEYWORDS,
          relevance: 0,
        },
        {
          begin: FUNCTION_TITLE, returnBegin: true,
          contains: [TITLE_MODE],
          relevance: 0
        },
        {
          className: 'params',
          begin: /\(/, end: /\)/,
          keywords: CPP_KEYWORDS,
          relevance: 0,
          contains: [
            C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE,
            STRINGS,
            NUMBERS,
            CPP_PRIMITIVE_TYPES,
            // Count matching parentheses.
            {
              begin: /\(/, end: /\)/,
              keywords: CPP_KEYWORDS,
              relevance: 0,
              contains: [
                'self',
                C_LINE_COMMENT_MODE,
                hljs.C_BLOCK_COMMENT_MODE,
                STRINGS,
                NUMBERS,
                CPP_PRIMITIVE_TYPES
              ]
            }
          ]
        },
        CPP_PRIMITIVE_TYPES,
        C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        PREPROCESSOR
      ]
    };

    return {
      aliases: ['c', 'cc', 'h', 'c++', 'h++', 'hpp', 'hh', 'hxx', 'cxx'],
      keywords: CPP_KEYWORDS,
      // the base c-like language will NEVER be auto-detected, rather the
      // derivitives: c, c++, arduino turn auto-detect back on for themselves
      disableAutodetect: true,
      illegal: '</',
      contains: [].concat(
        EXPRESSION_CONTEXT,
        FUNCTION_DECLARATION,
        EXPRESSION_CONTAINS,
        [
        PREPROCESSOR,
        { // containers: ie, `vector <int> rooms (9);`
          begin: '\\b(deque|list|queue|priority_queue|pair|stack|vector|map|set|bitset|multiset|multimap|unordered_map|unordered_set|unordered_multiset|unordered_multimap|array)\\s*<', end: '>',
          keywords: CPP_KEYWORDS,
          contains: ['self', CPP_PRIMITIVE_TYPES]
        },
        {
          begin: hljs.IDENT_RE + '::',
          keywords: CPP_KEYWORDS
        },
        {
          className: 'class',
          beginKeywords: 'enum class struct union', end: /[{;:<>=]/,
          contains: [
            { beginKeywords: "final class struct" },
            hljs.TITLE_MODE
          ]
        }
      ]),
      exports: {
        preprocessor: PREPROCESSOR,
        strings: STRINGS,
        keywords: CPP_KEYWORDS
      }
    };
  }

  return cLike;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('cpp', function () {
  'use strict';

  /*
  Language: C++
  Category: common, system
  Website: https://isocpp.org
  Requires: c-like.js
  */

  /** @type LanguageFn */
  function cpp(hljs) {
    var lang = hljs.requireLanguage('c-like').rawDefinition();
    // return auto-detection back on
    lang.disableAutodetect = false;
    lang.name = 'C++';
    lang.aliases = ['cc', 'c++', 'h++', 'hpp', 'hh', 'hxx', 'cxx'];
    return lang;
  }

  return cpp;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('diff', function () {
  'use strict';

  /*
  Language: Diff
  Description: Unified and context diff
  Author: Vasily Polovnyov <vast@whiteants.net>
  Website: https://www.gnu.org/software/diffutils/
  Category: common
  */

  /** @type LanguageFn */
  function diff(hljs) {
    return {
      name: 'Diff',
      aliases: ['patch'],
      contains: [
        {
          className: 'meta',
          relevance: 10,
          variants: [
            {begin: /^@@ +\-\d+,\d+ +\+\d+,\d+ +@@$/},
            {begin: /^\*\*\* +\d+,\d+ +\*\*\*\*$/},
            {begin: /^\-\-\- +\d+,\d+ +\-\-\-\-$/}
          ]
        },
        {
          className: 'comment',
          variants: [
            {begin: /Index: /, end: /$/},
            {begin: /={3,}/, end: /$/},
            {begin: /^\-{3}/, end: /$/},
            {begin: /^\*{3} /, end: /$/},
            {begin: /^\+{3}/, end: /$/},
            {begin: /^\*{15}$/ }
          ]
        },
        {
          className: 'addition',
          begin: '^\\+', end: '$'
        },
        {
          className: 'deletion',
          begin: '^\\-', end: '$'
        },
        {
          className: 'addition',
          begin: '^\\!', end: '$'
        }
      ]
    };
  }

  return diff;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('sql', function () {
  'use strict';

  /*
   Language: SQL
   Contributors: Nikolay Lisienko <info@neor.ru>, Heiko August <post@auge8472.de>, Travis Odom <travis.a.odom@gmail.com>, Vadimtro <vadimtro@yahoo.com>, Benjamin Auder <benjamin.auder@gmail.com>
   Website: https://en.wikipedia.org/wiki/SQL
   Category: common
   */

  function sql(hljs) {
    var COMMENT_MODE = hljs.COMMENT('--', '$');
    return {
      name: 'SQL',
      case_insensitive: true,
      illegal: /[<>{}*]/,
      contains: [
        {
          beginKeywords:
            'begin end start commit rollback savepoint lock alter create drop rename call ' +
            'delete do handler insert load replace select truncate update set show pragma grant ' +
            'merge describe use explain help declare prepare execute deallocate release ' +
            'unlock purge reset change stop analyze cache flush optimize repair kill ' +
            'install uninstall checksum restore check backup revoke comment values with',
          end: /;/, endsWithParent: true,
          keywords: {
            $pattern: /[\w\.]+/,
            keyword:
              'as abort abs absolute acc acce accep accept access accessed accessible account acos action activate add ' +
              'addtime admin administer advanced advise aes_decrypt aes_encrypt after agent aggregate ali alia alias ' +
              'all allocate allow alter always analyze ancillary and anti any anydata anydataset anyschema anytype apply ' +
              'archive archived archivelog are as asc ascii asin assembly assertion associate asynchronous at atan ' +
              'atn2 attr attri attrib attribu attribut attribute attributes audit authenticated authentication authid ' +
              'authors auto autoallocate autodblink autoextend automatic availability avg backup badfile basicfile ' +
              'before begin beginning benchmark between bfile bfile_base big bigfile bin binary_double binary_float ' +
              'binlog bit_and bit_count bit_length bit_or bit_xor bitmap blob_base block blocksize body both bound ' +
              'bucket buffer_cache buffer_pool build bulk by byte byteordermark bytes cache caching call calling cancel ' +
              'capacity cascade cascaded case cast catalog category ceil ceiling chain change changed char_base ' +
              'char_length character_length characters characterset charindex charset charsetform charsetid check ' +
              'checksum checksum_agg child choose chr chunk class cleanup clear client clob clob_base clone close ' +
              'cluster_id cluster_probability cluster_set clustering coalesce coercibility col collate collation ' +
              'collect colu colum column column_value columns columns_updated comment commit compact compatibility ' +
              'compiled complete composite_limit compound compress compute concat concat_ws concurrent confirm conn ' +
              'connec connect connect_by_iscycle connect_by_isleaf connect_by_root connect_time connection ' +
              'consider consistent constant constraint constraints constructor container content contents context ' +
              'contributors controlfile conv convert convert_tz corr corr_k corr_s corresponding corruption cos cost ' +
              'count count_big counted covar_pop covar_samp cpu_per_call cpu_per_session crc32 create creation ' +
              'critical cross cube cume_dist curdate current current_date current_time current_timestamp current_user ' +
              'cursor curtime customdatum cycle data database databases datafile datafiles datalength date_add ' +
              'date_cache date_format date_sub dateadd datediff datefromparts datename datepart datetime2fromparts ' +
              'day day_to_second dayname dayofmonth dayofweek dayofyear days db_role_change dbtimezone ddl deallocate ' +
              'declare decode decompose decrement decrypt deduplicate def defa defau defaul default defaults ' +
              'deferred defi defin define degrees delayed delegate delete delete_all delimited demand dense_rank ' +
              'depth dequeue des_decrypt des_encrypt des_key_file desc descr descri describ describe descriptor ' +
              'deterministic diagnostics difference dimension direct_load directory disable disable_all ' +
              'disallow disassociate discardfile disconnect diskgroup distinct distinctrow distribute distributed div ' +
              'do document domain dotnet double downgrade drop dumpfile duplicate duration each edition editionable ' +
              'editions element ellipsis else elsif elt empty enable enable_all enclosed encode encoding encrypt ' +
              'end end-exec endian enforced engine engines enqueue enterprise entityescaping eomonth error errors ' +
              'escaped evalname evaluate event eventdata events except exception exceptions exchange exclude excluding ' +
              'execu execut execute exempt exists exit exp expire explain explode export export_set extended extent external ' +
              'external_1 external_2 externally extract failed failed_login_attempts failover failure far fast ' +
              'feature_set feature_value fetch field fields file file_name_convert filesystem_like_logging final ' +
              'finish first first_value fixed flash_cache flashback floor flush following follows for forall force foreign ' +
              'form forma format found found_rows freelist freelists freepools fresh from from_base64 from_days ' +
              'ftp full function general generated get get_format get_lock getdate getutcdate global global_name ' +
              'globally go goto grant grants greatest group group_concat group_id grouping grouping_id groups ' +
              'gtid_subtract guarantee guard handler hash hashkeys having hea head headi headin heading heap help hex ' +
              'hierarchy high high_priority hosts hour hours http id ident_current ident_incr ident_seed identified ' +
              'identity idle_time if ifnull ignore iif ilike ilm immediate import in include including increment ' +
              'index indexes indexing indextype indicator indices inet6_aton inet6_ntoa inet_aton inet_ntoa infile ' +
              'initial initialized initially initrans inmemory inner innodb input insert install instance instantiable ' +
              'instr interface interleaved intersect into invalidate invisible is is_free_lock is_ipv4 is_ipv4_compat ' +
              'is_not is_not_null is_used_lock isdate isnull isolation iterate java join json json_exists ' +
              'keep keep_duplicates key keys kill language large last last_day last_insert_id last_value lateral lax lcase ' +
              'lead leading least leaves left len lenght length less level levels library like like2 like4 likec limit ' +
              'lines link list listagg little ln load load_file lob lobs local localtime localtimestamp locate ' +
              'locator lock locked log log10 log2 logfile logfiles logging logical logical_reads_per_call ' +
              'logoff logon logs long loop low low_priority lower lpad lrtrim ltrim main make_set makedate maketime ' +
              'managed management manual map mapping mask master master_pos_wait match matched materialized max ' +
              'maxextents maximize maxinstances maxlen maxlogfiles maxloghistory maxlogmembers maxsize maxtrans ' +
              'md5 measures median medium member memcompress memory merge microsecond mid migration min minextents ' +
              'minimum mining minus minute minutes minvalue missing mod mode model modification modify module monitoring month ' +
              'months mount move movement multiset mutex name name_const names nan national native natural nav nchar ' +
              'nclob nested never new newline next nextval no no_write_to_binlog noarchivelog noaudit nobadfile ' +
              'nocheck nocompress nocopy nocycle nodelay nodiscardfile noentityescaping noguarantee nokeep nologfile ' +
              'nomapping nomaxvalue nominimize nominvalue nomonitoring none noneditionable nonschema noorder ' +
              'nopr nopro noprom nopromp noprompt norely noresetlogs noreverse normal norowdependencies noschemacheck ' +
              'noswitch not nothing notice notnull notrim novalidate now nowait nth_value nullif nulls num numb numbe ' +
              'nvarchar nvarchar2 object ocicoll ocidate ocidatetime ociduration ociinterval ociloblocator ocinumber ' +
              'ociref ocirefcursor ocirowid ocistring ocitype oct octet_length of off offline offset oid oidindex old ' +
              'on online only opaque open operations operator optimal optimize option optionally or oracle oracle_date ' +
              'oradata ord ordaudio orddicom orddoc order ordimage ordinality ordvideo organization orlany orlvary ' +
              'out outer outfile outline output over overflow overriding package pad parallel parallel_enable ' +
              'parameters parent parse partial partition partitions pascal passing password password_grace_time ' +
              'password_lock_time password_reuse_max password_reuse_time password_verify_function patch path patindex ' +
              'pctincrease pctthreshold pctused pctversion percent percent_rank percentile_cont percentile_disc ' +
              'performance period period_add period_diff permanent physical pi pipe pipelined pivot pluggable plugin ' +
              'policy position post_transaction pow power pragma prebuilt precedes preceding precision prediction ' +
              'prediction_cost prediction_details prediction_probability prediction_set prepare present preserve ' +
              'prior priority private private_sga privileges procedural procedure procedure_analyze processlist ' +
              'profiles project prompt protection public publishingservername purge quarter query quick quiesce quota ' +
              'quotename radians raise rand range rank raw read reads readsize rebuild record records ' +
              'recover recovery recursive recycle redo reduced ref reference referenced references referencing refresh ' +
              'regexp_like register regr_avgx regr_avgy regr_count regr_intercept regr_r2 regr_slope regr_sxx regr_sxy ' +
              'reject rekey relational relative relaylog release release_lock relies_on relocate rely rem remainder rename ' +
              'repair repeat replace replicate replication required reset resetlogs resize resource respect restore ' +
              'restricted result result_cache resumable resume retention return returning returns reuse reverse revoke ' +
              'right rlike role roles rollback rolling rollup round row row_count rowdependencies rowid rownum rows ' +
              'rtrim rules safe salt sample save savepoint sb1 sb2 sb4 scan schema schemacheck scn scope scroll ' +
              'sdo_georaster sdo_topo_geometry search sec_to_time second seconds section securefile security seed segment select ' +
              'self semi sequence sequential serializable server servererror session session_user sessions_per_user set ' +
              'sets settings sha sha1 sha2 share shared shared_pool short show shrink shutdown si_averagecolor ' +
              'si_colorhistogram si_featurelist si_positionalcolor si_stillimage si_texture siblings sid sign sin ' +
              'size size_t sizes skip slave sleep smalldatetimefromparts smallfile snapshot some soname sort soundex ' +
              'source space sparse spfile split sql sql_big_result sql_buffer_result sql_cache sql_calc_found_rows ' +
              'sql_small_result sql_variant_property sqlcode sqldata sqlerror sqlname sqlstate sqrt square standalone ' +
              'standby start starting startup statement static statistics stats_binomial_test stats_crosstab ' +
              'stats_ks_test stats_mode stats_mw_test stats_one_way_anova stats_t_test_ stats_t_test_indep ' +
              'stats_t_test_one stats_t_test_paired stats_wsr_test status std stddev stddev_pop stddev_samp stdev ' +
              'stop storage store stored str str_to_date straight_join strcmp strict string struct stuff style subdate ' +
              'subpartition subpartitions substitutable substr substring subtime subtring_index subtype success sum ' +
              'suspend switch switchoffset switchover sync synchronous synonym sys sys_xmlagg sysasm sysaux sysdate ' +
              'sysdatetimeoffset sysdba sysoper system system_user sysutcdatetime table tables tablespace tablesample tan tdo ' +
              'template temporary terminated tertiary_weights test than then thread through tier ties time time_format ' +
              'time_zone timediff timefromparts timeout timestamp timestampadd timestampdiff timezone_abbr ' +
              'timezone_minute timezone_region to to_base64 to_date to_days to_seconds todatetimeoffset trace tracking ' +
              'transaction transactional translate translation treat trigger trigger_nestlevel triggers trim truncate ' +
              'try_cast try_convert try_parse type ub1 ub2 ub4 ucase unarchived unbounded uncompress ' +
              'under undo unhex unicode uniform uninstall union unique unix_timestamp unknown unlimited unlock unnest unpivot ' +
              'unrecoverable unsafe unsigned until untrusted unusable unused update updated upgrade upped upper upsert ' +
              'url urowid usable usage use use_stored_outlines user user_data user_resources users using utc_date ' +
              'utc_timestamp uuid uuid_short validate validate_password_strength validation valist value values var ' +
              'var_samp varcharc vari varia variab variabl variable variables variance varp varraw varrawc varray ' +
              'verify version versions view virtual visible void wait wallet warning warnings week weekday weekofyear ' +
              'wellformed when whene whenev wheneve whenever where while whitespace window with within without work wrapped ' +
              'xdb xml xmlagg xmlattributes xmlcast xmlcolattval xmlelement xmlexists xmlforest xmlindex xmlnamespaces ' +
              'xmlpi xmlquery xmlroot xmlschema xmlserialize xmltable xmltype xor year year_to_month years yearweek',
            literal:
              'true false null unknown',
            built_in:
              'array bigint binary bit blob bool boolean char character date dec decimal float int int8 integer interval number ' +
              'numeric real record serial serial8 smallint text time timestamp tinyint varchar varchar2 varying void'
          },
          contains: [
            {
              className: 'string',
              begin: '\'', end: '\'',
              contains: [{begin: '\'\''}]
            },
            {
              className: 'string',
              begin: '"', end: '"',
              contains: [{begin: '""'}]
            },
            {
              className: 'string',
              begin: '`', end: '`'
            },
            hljs.C_NUMBER_MODE,
            hljs.C_BLOCK_COMMENT_MODE,
            COMMENT_MODE,
            hljs.HASH_COMMENT_MODE
          ]
        },
        hljs.C_BLOCK_COMMENT_MODE,
        COMMENT_MODE,
        hljs.HASH_COMMENT_MODE
      ]
    };
  }

  return sql;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('dockerfile', function () {
  'use strict';

  /*
  Language: Dockerfile
  Requires: bash.js
  Author: Alexis Hénaut <alexis@henaut.net>
  Description: language definition for Dockerfile files
  Website: https://docs.docker.com/engine/reference/builder/
  Category: config
  */

  function dockerfile(hljs) {
    return {
      name: 'Dockerfile',
      aliases: ['docker'],
      case_insensitive: true,
      keywords: 'from maintainer expose env arg user onbuild stopsignal',
      contains: [
        hljs.HASH_COMMENT_MODE,
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        hljs.NUMBER_MODE,
        {
          beginKeywords: 'run cmd entrypoint volume add copy workdir label healthcheck shell',
          starts: {
            end: /[^\\]$/,
            subLanguage: 'bash'
          }
        }
      ],
      illegal: '</'
    }
  }

  return dockerfile;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('shell', function () {
  'use strict';

  /*
  Language: Shell Session
  Requires: bash.js
  Author: TSUYUSATO Kitsune <make.just.on@gmail.com>
  Category: common
  */

  function shell(hljs) {
    return {
      name: 'Shell Session',
      aliases: ['console'],
      contains: [
        {
          className: 'meta',
          begin: '^\\s{0,3}[/\\w\\d\\[\\]()@-]*[>%$#]',
          starts: {
            end: '$', subLanguage: 'bash'
          }
        }
      ]
    }
  }

  return shell;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('go', function () {
  'use strict';

  /*
  Language: Go
  Author: Stephan Kountso aka StepLg <steplg@gmail.com>
  Contributors: Evgeny Stepanischev <imbolk@gmail.com>
  Description: Google go language (golang). For info about language
  Website: http://golang.org/
  Category: common, system
  */

  function go(hljs) {
    var GO_KEYWORDS = {
      keyword:
        'break default func interface select case map struct chan else goto package switch ' +
        'const fallthrough if range type continue for import return var go defer ' +
        'bool byte complex64 complex128 float32 float64 int8 int16 int32 int64 string uint8 ' +
        'uint16 uint32 uint64 int uint uintptr rune',
      literal:
         'true false iota nil',
      built_in:
        'append cap close complex copy imag len make new panic print println real recover delete'
    };
    return {
      name: 'Go',
      aliases: ['golang'],
      keywords: GO_KEYWORDS,
      illegal: '</',
      contains: [
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        {
          className: 'string',
          variants: [
            hljs.QUOTE_STRING_MODE,
            hljs.APOS_STRING_MODE,
            {begin: '`', end: '`'},
          ]
        },
        {
          className: 'number',
          variants: [
            {begin: hljs.C_NUMBER_RE + '[i]', relevance: 1},
            hljs.C_NUMBER_MODE
          ]
        },
        {
          begin: /:=/ // relevance booster
        },
        {
          className: 'function',
          beginKeywords: 'func', end: '\\s*(\\{|$)', excludeEnd: true,
          contains: [
            hljs.TITLE_MODE,
            {
              className: 'params',
              begin: /\(/, end: /\)/,
              keywords: GO_KEYWORDS,
              illegal: /["']/
            }
          ]
        }
      ]
    };
  }

  return go;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('apache', function () {
  'use strict';

  /*
  Language: Apache config
  Author: Ruslan Keba <rukeba@gmail.com>
  Contributors: Ivan Sagalaev <maniac@softwaremaniacs.org>
  Website: https://httpd.apache.org
  Description: language definition for Apache configuration files (httpd.conf & .htaccess)
  Category: common, config
  */

  /** @type LanguageFn */
  function apache(hljs) {
    var NUMBER_REF = {className: 'number', begin: '[\\$%]\\d+'};
    var NUMBER = {className: 'number', begin: '\\d+'};
    var IP_ADDRESS = {
      className: "number",
      begin: '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(:\\d{1,5})?'
    };
    var PORT_NUMBER = {
      className: "number",
      begin: ":\\d{1,5}"
    };
    return {
      name: 'Apache config',
      aliases: ['apacheconf'],
      case_insensitive: true,
      contains: [
        hljs.HASH_COMMENT_MODE,
        {className: 'section', begin: '</?', end: '>',
        contains: [
          IP_ADDRESS,
          PORT_NUMBER,
          // low relevance prevents us from claming XML/HTML where this rule would
          // match strings inside of XML tags
          hljs.inherit(hljs.QUOTE_STRING_MODE, { relevance:0 })
        ]
      },
        {
          className: 'attribute',
          begin: /\w+/,
          relevance: 0,
          // keywords aren’t needed for highlighting per se, they only boost relevance
          // for a very generally defined mode (starts with a word, ends with line-end
          keywords: {
            nomarkup:
              'order deny allow setenv rewriterule rewriteengine rewritecond documentroot ' +
              'sethandler errordocument loadmodule options header listen serverroot ' +
              'servername'
          },
          starts: {
            end: /$/,
            relevance: 0,
            keywords: {
              literal: 'on off all deny allow'
            },
            contains: [
              {
                className: 'meta',
                begin: '\\s\\[', end: '\\]$'
              },
              {
                className: 'variable',
                begin: '[\\$%]\\{', end: '\\}',
                contains: ['self', NUMBER_REF]
              },
              IP_ADDRESS,
              NUMBER,
              hljs.QUOTE_STRING_MODE
            ]
          }
        }
      ],
      illegal: /\S/
    };
  }

  return apache;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('c', function () {
  'use strict';

  /*
  Language: C
  Category: common, system
  Website: https://en.wikipedia.org/wiki/C_(programming_language)
  Requires: c-like.js
  */

  /** @type LanguageFn */
  function c(hljs) {
    var lang = hljs.requireLanguage('c-like').rawDefinition();
    // Until C is actually different than C++ there is no reason to auto-detect C
    // as it's own language since it would just fail auto-detect testing or
    // simply match with C++.
    //
    // See further comments in c-like.js.

    // lang.disableAutodetect = false;
    lang.name = 'C';
    lang.aliases = ['c', 'h'];
    return lang;
  }

  return c;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('coffeescript', function () {
  'use strict';

  const KEYWORDS = [
    "as", // for exports
    "in",
    "of",
    "if",
    "for",
    "while",
    "finally",
    "var",
    "new",
    "function",
    "do",
    "return",
    "void",
    "else",
    "break",
    "catch",
    "instanceof",
    "with",
    "throw",
    "case",
    "default",
    "try",
    "switch",
    "continue",
    "typeof",
    "delete",
    "let",
    "yield",
    "const",
    "class",
    // JS handles these with a special rule
    // "get",
    // "set",
    "debugger",
    "async",
    "await",
    "static",
    "import",
    "from",
    "export",
    "extends"
  ];
  const LITERALS = [
    "true",
    "false",
    "null",
    "undefined",
    "NaN",
    "Infinity"
  ];

  const TYPES = [
    "Intl",
    "DataView",
    "Number",
    "Math",
    "Date",
    "String",
    "RegExp",
    "Object",
    "Function",
    "Boolean",
    "Error",
    "Symbol",
    "Set",
    "Map",
    "WeakSet",
    "WeakMap",
    "Proxy",
    "Reflect",
    "JSON",
    "Promise",
    "Float64Array",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "Uint16Array",
    "Uint32Array",
    "Float32Array",
    "Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "ArrayBuffer"
  ];

  const ERROR_TYPES = [
    "EvalError",
    "InternalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError"
  ];

  const BUILT_IN_GLOBALS = [
    "setInterval",
    "setTimeout",
    "clearInterval",
    "clearTimeout",

    "require",
    "exports",

    "eval",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "unescape"
  ];

  const BUILT_IN_VARIABLES = [
    "arguments",
    "this",
    "super",
    "console",
    "window",
    "document",
    "localStorage",
    "module",
    "global" // Node.js
  ];

  const BUILT_INS = [].concat(
    BUILT_IN_GLOBALS,
    BUILT_IN_VARIABLES,
    TYPES,
    ERROR_TYPES
  );

  /*
  Language: CoffeeScript
  Author: Dmytrii Nagirniak <dnagir@gmail.com>
  Contributors: Oleg Efimov <efimovov@gmail.com>, Cédric Néhémie <cedric.nehemie@gmail.com>
  Description: CoffeeScript is a programming language that transcompiles to JavaScript. For info about language see http://coffeescript.org/
  Category: common, scripting
  Website: https://coffeescript.org
  */

  /** @type LanguageFn */
  function coffeescript(hljs) {
    var COFFEE_BUILT_INS = [
      'npm',
      'print'
    ];
    var COFFEE_LITERALS = [
      'yes',
      'no',
      'on',
      'off'
    ];
    var COFFEE_KEYWORDS = [
      'then',
      'unless',
      'until',
      'loop',
      'by',
      'when',
      'and',
      'or',
      'is',
      'isnt',
      'not'
    ];
    var NOT_VALID_KEYWORDS = [
      "var",
      "const",
      "let",
      "function",
      "static"
    ];
    var excluding = (list) =>
      (kw) => !list.includes(kw);
    var KEYWORDS$1 = {
      keyword: KEYWORDS.concat(COFFEE_KEYWORDS).filter(excluding(NOT_VALID_KEYWORDS)).join(" "),
      literal: LITERALS.concat(COFFEE_LITERALS).join(" "),
      built_in: BUILT_INS.concat(COFFEE_BUILT_INS).join(" ")
    };
    var JS_IDENT_RE = '[A-Za-z$_][0-9A-Za-z$_]*';
    var SUBST = {
      className: 'subst',
      begin: /#\{/, end: /}/,
      keywords: KEYWORDS$1
    };
    var EXPRESSIONS = [
      hljs.BINARY_NUMBER_MODE,
      hljs.inherit(hljs.C_NUMBER_MODE, {starts: {end: '(\\s*/)?', relevance: 0}}), // a number tries to eat the following slash to prevent treating it as a regexp
      {
        className: 'string',
        variants: [
          {
            begin: /'''/, end: /'''/,
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          {
            begin: /'/, end: /'/,
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          {
            begin: /"""/, end: /"""/,
            contains: [hljs.BACKSLASH_ESCAPE, SUBST]
          },
          {
            begin: /"/, end: /"/,
            contains: [hljs.BACKSLASH_ESCAPE, SUBST]
          }
        ]
      },
      {
        className: 'regexp',
        variants: [
          {
            begin: '///', end: '///',
            contains: [SUBST, hljs.HASH_COMMENT_MODE]
          },
          {
            begin: '//[gim]{0,3}(?=\\W)',
            relevance: 0
          },
          {
            // regex can't start with space to parse x / 2 / 3 as two divisions
            // regex can't start with *, and it supports an "illegal" in the main mode
            begin: /\/(?![ *]).*?(?![\\]).\/[gim]{0,3}(?=\W)/
          }
        ]
      },
      {
        begin: '@' + JS_IDENT_RE // relevance booster
      },
      {
        subLanguage: 'javascript',
        excludeBegin: true, excludeEnd: true,
        variants: [
          {
            begin: '```', end: '```',
          },
          {
            begin: '`', end: '`',
          }
        ]
      }
    ];
    SUBST.contains = EXPRESSIONS;

    var TITLE = hljs.inherit(hljs.TITLE_MODE, {begin: JS_IDENT_RE});
    var PARAMS_RE = '(\\(.*\\))?\\s*\\B[-=]>';
    var PARAMS = {
      className: 'params',
      begin: '\\([^\\(]', returnBegin: true,
      /* We need another contained nameless mode to not have every nested
      pair of parens to be called "params" */
      contains: [{
        begin: /\(/, end: /\)/,
        keywords: KEYWORDS$1,
        contains: ['self'].concat(EXPRESSIONS)
      }]
    };

    return {
      name: 'CoffeeScript',
      aliases: ['coffee', 'cson', 'iced'],
      keywords: KEYWORDS$1,
      illegal: /\/\*/,
      contains: EXPRESSIONS.concat([
        hljs.COMMENT('###', '###'),
        hljs.HASH_COMMENT_MODE,
        {
          className: 'function',
          begin: '^\\s*' + JS_IDENT_RE + '\\s*=\\s*' + PARAMS_RE, end: '[-=]>',
          returnBegin: true,
          contains: [TITLE, PARAMS]
        },
        {
          // anonymous function start
          begin: /[:\(,=]\s*/,
          relevance: 0,
          contains: [
            {
              className: 'function',
              begin: PARAMS_RE, end: '[-=]>',
              returnBegin: true,
              contains: [PARAMS]
            }
          ]
        },
        {
          className: 'class',
          beginKeywords: 'class',
          end: '$',
          illegal: /[:="\[\]]/,
          contains: [
            {
              beginKeywords: 'extends',
              endsWithParent: true,
              illegal: /[:="\[\]]/,
              contains: [TITLE]
            },
            TITLE
          ]
        },
        {
          begin: JS_IDENT_RE + ':', end: ':',
          returnBegin: true, returnEnd: true,
          relevance: 0
        }
      ])
    };
  }

  return coffeescript;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('css', function () {
  'use strict';

  /*
  Language: CSS
  Category: common, css
  Website: https://developer.mozilla.org/en-US/docs/Web/CSS
  */

  /** @type LanguageFn */
  function css(hljs) {
    var FUNCTION_LIKE = {
      begin: /[\w-]+\(/, returnBegin: true,
      contains: [
        {
          className: 'built_in',
          begin: /[\w-]+/
        },
        {
          begin: /\(/, end: /\)/,
          contains: [
            hljs.APOS_STRING_MODE,
            hljs.QUOTE_STRING_MODE,
            hljs.CSS_NUMBER_MODE,
          ]
        }
      ]
    };
    var ATTRIBUTE = {
      className: 'attribute',
      begin: /\S/, end: ':', excludeEnd: true,
      starts: {
        endsWithParent: true, excludeEnd: true,
        contains: [
          FUNCTION_LIKE,
          hljs.CSS_NUMBER_MODE,
          hljs.QUOTE_STRING_MODE,
          hljs.APOS_STRING_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          {
            className: 'number', begin: '#[0-9A-Fa-f]+'
          },
          {
            className: 'meta', begin: '!important'
          }
        ]
      }
    };
    var AT_IDENTIFIER = '@[a-z-]+'; // @font-face
    var AT_MODIFIERS = "and or not only";
    var AT_PROPERTY_RE = /@\-?\w[\w]*(\-\w+)*/; // @-webkit-keyframes
    var IDENT_RE = '[a-zA-Z-][a-zA-Z0-9_-]*';
    var RULE = {
      begin: /(?:[A-Z\_\.\-]+|--[a-zA-Z0-9_-]+)\s*:/, returnBegin: true, end: ';', endsWithParent: true,
      contains: [
        ATTRIBUTE
      ]
    };

    return {
      name: 'CSS',
      case_insensitive: true,
      illegal: /[=\/|'\$]/,
      contains: [
        hljs.C_BLOCK_COMMENT_MODE,
        {
          className: 'selector-id', begin: /#[A-Za-z0-9_-]+/
        },
        {
          className: 'selector-class', begin: /\.[A-Za-z0-9_-]+/
        },
        {
          className: 'selector-attr',
          begin: /\[/, end: /\]/,
          illegal: '$',
          contains: [
            hljs.APOS_STRING_MODE,
            hljs.QUOTE_STRING_MODE,
          ]
        },
        {
          className: 'selector-pseudo',
          begin: /:(:)?[a-zA-Z0-9\_\-\+\(\)"'.]+/
        },
        // matching these here allows us to treat them more like regular CSS
        // rules so everything between the {} gets regular rule highlighting,
        // which is what we want for page and font-face
        {
          begin: '@(page|font-face)',
          lexemes: AT_IDENTIFIER,
          keywords: '@page @font-face'
        },
        {
          begin: '@', end: '[{;]', // at_rule eating first "{" is a good thing
                                   // because it doesn’t let it to be parsed as
                                   // a rule set but instead drops parser into
                                   // the default mode which is how it should be.
          illegal: /:/, // break on Less variables @var: ...
          returnBegin: true,
          contains: [
            {
              className: 'keyword',
              begin: AT_PROPERTY_RE
            },
            {
              begin: /\s/, endsWithParent: true, excludeEnd: true,
              relevance: 0,
              keywords: AT_MODIFIERS,
              contains: [
                {
                  begin: /[a-z-]+:/,
                  className:"attribute"
                },
                hljs.APOS_STRING_MODE,
                hljs.QUOTE_STRING_MODE,
                hljs.CSS_NUMBER_MODE
              ]
            }
          ]
        },
        {
          className: 'selector-tag', begin: IDENT_RE,
          relevance: 0
        },
        {
          begin: '{', end: '}',
          illegal: /\S/,
          contains: [
            hljs.C_BLOCK_COMMENT_MODE,
            RULE,
          ]
        }
      ]
    };
  }

  return css;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('http', function () {
  'use strict';

  /*
  Language: HTTP
  Description: HTTP request and response headers with automatic body highlighting
  Author: Ivan Sagalaev <maniac@softwaremaniacs.org>
  Category: common, protocols
  Website: https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview
  */

  function http(hljs) {
    var VERSION = 'HTTP/[0-9\\.]+';
    return {
      name: 'HTTP',
      aliases: ['https'],
      illegal: '\\S',
      contains: [
        {
          begin: '^' + VERSION, end: '$',
          contains: [{className: 'number', begin: '\\b\\d{3}\\b'}]
        },
        {
          begin: '^[A-Z]+ (.*?) ' + VERSION + '$', returnBegin: true, end: '$',
          contains: [
            {
              className: 'string',
              begin: ' ', end: ' ',
              excludeBegin: true, excludeEnd: true
            },
            {
              begin: VERSION
            },
            {
              className: 'keyword',
              begin: '[A-Z]+'
            }
          ]
        },
        {
          className: 'attribute',
          begin: '^\\w', end: ': ', excludeEnd: true,
          illegal: '\\n|\\s|=',
          starts: {end: '$', relevance: 0}
        },
        {
          begin: '\\n\\n',
          starts: {subLanguage: [], endsWithParent: true}
        }
      ]
    };
  }

  return http;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('ini', function () {
  'use strict';

  /**
   * @param {string} value
   * @returns {RegExp}
   * */

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function source(re) {
    if (!re) return null;
    if (typeof re === "string") return re;

    return re.source;
  }

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function lookahead(re) {
    return concat('(?=', re, ')');
  }

  /**
   * @param {...(RegExp | string) } args
   * @returns {string}
   */
  function concat(...args) {
    const joined = args.map((x) => source(x)).join("");
    return joined;
  }

  /**
   * Any of the passed expresssions may match
   *
   * Creates a huge this | this | that | that match
   * @param {(RegExp | string)[] } args
   * @returns {string}
   */
  function either(...args) {
    const joined = '(' + args.map((x) => source(x)).join("|") + ")";
    return joined;
  }

  /*
  Language: TOML, also INI
  Description: TOML aims to be a minimal configuration file format that's easy to read due to obvious semantics.
  Contributors: Guillaume Gomez <guillaume1.gomez@gmail.com>
  Category: common, config
  Website: https://github.com/toml-lang/toml
  */

  function ini(hljs) {
    var NUMBERS = {
      className: 'number',
      relevance: 0,
      variants: [
        { begin: /([\+\-]+)?[\d]+_[\d_]+/ },
        { begin: hljs.NUMBER_RE }
      ]
    };
    var COMMENTS = hljs.COMMENT();
    COMMENTS.variants = [
      {begin: /;/, end: /$/},
      {begin: /#/, end: /$/},
    ];
    var VARIABLES = {
      className: 'variable',
      variants: [
        { begin: /\$[\w\d"][\w\d_]*/ },
        { begin: /\$\{(.*?)}/ }
      ]
    };
    var LITERALS = {
      className: 'literal',
      begin: /\bon|off|true|false|yes|no\b/
    };
    var STRINGS = {
      className: "string",
      contains: [hljs.BACKSLASH_ESCAPE],
      variants: [
        { begin: "'''", end: "'''", relevance: 10 },
        { begin: '"""', end: '"""', relevance: 10 },
        { begin: '"', end: '"' },
        { begin: "'", end: "'" }
      ]
    };
    var ARRAY = {
      begin: /\[/, end: /\]/,
      contains: [
        COMMENTS,
        LITERALS,
        VARIABLES,
        STRINGS,
        NUMBERS,
        'self'
      ],
      relevance:0
    };

    var BARE_KEY = /[A-Za-z0-9_-]+/;
    var QUOTED_KEY_DOUBLE_QUOTE = /"(\\"|[^"])*"/;
    var QUOTED_KEY_SINGLE_QUOTE = /'[^']*'/;
    var ANY_KEY = either(
      BARE_KEY, QUOTED_KEY_DOUBLE_QUOTE, QUOTED_KEY_SINGLE_QUOTE
    );
    var DOTTED_KEY = concat(
      ANY_KEY, '(\\s*\\.\\s*', ANY_KEY, ')*',
      lookahead(/\s*=\s*[^#\s]/)
    );

    return {
      name: 'TOML, also INI',
      aliases: ['toml'],
      case_insensitive: true,
      illegal: /\S/,
      contains: [
        COMMENTS,
        {
          className: 'section',
          begin: /\[+/, end: /\]+/
        },
        {
          begin: DOTTED_KEY,
          className: 'attr',
          starts: {
            end: /$/,
            contains: [
              COMMENTS,
              ARRAY,
              LITERALS,
              VARIABLES,
              STRINGS,
              NUMBERS
            ]
          }
        }
      ]
    };
  }

  return ini;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('javascript', function () {
  'use strict';

  const IDENT_RE = '[A-Za-z$_][0-9A-Za-z$_]*';
  const KEYWORDS = [
    "as", // for exports
    "in",
    "of",
    "if",
    "for",
    "while",
    "finally",
    "var",
    "new",
    "function",
    "do",
    "return",
    "void",
    "else",
    "break",
    "catch",
    "instanceof",
    "with",
    "throw",
    "case",
    "default",
    "try",
    "switch",
    "continue",
    "typeof",
    "delete",
    "let",
    "yield",
    "const",
    "class",
    // JS handles these with a special rule
    // "get",
    // "set",
    "debugger",
    "async",
    "await",
    "static",
    "import",
    "from",
    "export",
    "extends"
  ];
  const LITERALS = [
    "true",
    "false",
    "null",
    "undefined",
    "NaN",
    "Infinity"
  ];

  const TYPES = [
    "Intl",
    "DataView",
    "Number",
    "Math",
    "Date",
    "String",
    "RegExp",
    "Object",
    "Function",
    "Boolean",
    "Error",
    "Symbol",
    "Set",
    "Map",
    "WeakSet",
    "WeakMap",
    "Proxy",
    "Reflect",
    "JSON",
    "Promise",
    "Float64Array",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "Uint16Array",
    "Uint32Array",
    "Float32Array",
    "Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "ArrayBuffer"
  ];

  const ERROR_TYPES = [
    "EvalError",
    "InternalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError"
  ];

  const BUILT_IN_GLOBALS = [
    "setInterval",
    "setTimeout",
    "clearInterval",
    "clearTimeout",

    "require",
    "exports",

    "eval",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "unescape"
  ];

  const BUILT_IN_VARIABLES = [
    "arguments",
    "this",
    "super",
    "console",
    "window",
    "document",
    "localStorage",
    "module",
    "global" // Node.js
  ];

  const BUILT_INS = [].concat(
    BUILT_IN_GLOBALS,
    BUILT_IN_VARIABLES,
    TYPES,
    ERROR_TYPES
  );

  /**
   * @param {string} value
   * @returns {RegExp}
   * */

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function source(re) {
    if (!re) return null;
    if (typeof re === "string") return re;

    return re.source;
  }

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function lookahead(re) {
    return concat('(?=', re, ')');
  }

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function optional(re) {
    return concat('(', re, ')?');
  }

  /**
   * @param {...(RegExp | string) } args
   * @returns {string}
   */
  function concat(...args) {
    const joined = args.map((x) => source(x)).join("");
    return joined;
  }

  /*
  Language: JavaScript
  Description: JavaScript (JS) is a lightweight, interpreted, or just-in-time compiled programming language with first-class functions.
  Category: common, scripting
  Website: https://developer.mozilla.org/en-US/docs/Web/JavaScript
  */

  /** @type LanguageFn */
  function javascript(hljs) {
    /**
     * Takes a string like "<Booger" and checks to see
     * if we can find a matching "</Booger" later in the
     * content.
     * @param {RegExpMatchArray} match
     * @param {{after:number}} param1
     */
    const hasClosingTag = (match, { after }) => {
      const tag = match[0].replace("<", "</");
      const pos = match.input.indexOf(tag, after);
      return pos !== -1;
    };

    const IDENT_RE$1 = IDENT_RE;
    const FRAGMENT = {
      begin: '<>',
      end: '</>'
    };
    const XML_TAG = {
      begin: /<[A-Za-z0-9\\._:-]+/,
      end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
      /**
       * @param {RegExpMatchArray} match
       * @param {CallbackResponse} response
       */
      isTrulyOpeningTag: (match, response) => {
        const afterMatchIndex = match[0].length + match.index;
        const nextChar = match.input[afterMatchIndex];
        // nested type?
        // HTML should not include another raw `<` inside a tag
        // But a type might: `<Array<Array<number>>`, etc.
        if (nextChar === "<") {
          response.ignoreMatch();
          return;
        }
        // <something>
        // This is now either a tag or a type.
        if (nextChar === ">") {
          // if we cannot find a matching closing tag, then we
          // will ignore it
          if (!hasClosingTag(match, { after: afterMatchIndex })) {
            response.ignoreMatch();
          }
        }
      }
    };
    const KEYWORDS$1 = {
      $pattern: IDENT_RE,
      keyword: KEYWORDS.join(" "),
      literal: LITERALS.join(" "),
      built_in: BUILT_INS.join(" ")
    };
    const nonDecimalLiterals = (prefixLetters, validChars) =>
      `\\b0[${prefixLetters}][${validChars}]([${validChars}_]*[${validChars}])?n?`;
    const noLeadingZeroDecimalDigits = /[1-9]([0-9_]*\d)?/;
    const decimalDigits = /\d([0-9_]*\d)?/;
    const exponentPart = concat(/[eE][+-]?/, decimalDigits);
    const NUMBER = {
      className: 'number',
      variants: [
        { begin: nonDecimalLiterals('bB', '01') }, // Binary literals
        { begin: nonDecimalLiterals('oO', '0-7') }, // Octal literals
        { begin: nonDecimalLiterals('xX', '0-9a-fA-F') }, // Hexadecimal literals
        { begin: concat(/\b/, noLeadingZeroDecimalDigits, 'n') }, // Non-zero BigInt literals
        { begin: concat(/(\b0)?\./, decimalDigits, optional(exponentPart)) }, // Decimal literals between 0 and 1
        { begin: concat(
          /\b/,
          noLeadingZeroDecimalDigits,
          optional(concat(/\./, optional(decimalDigits))), // fractional part
          optional(exponentPart)
          ) }, // Decimal literals >= 1
        { begin: /\b0[\.n]?/ }, // Zero literals (`0`, `0.`, `0n`)
      ],
      relevance: 0
    };
    const SUBST = {
      className: 'subst',
      begin: '\\$\\{',
      end: '\\}',
      keywords: KEYWORDS$1,
      contains: [] // defined later
    };
    const HTML_TEMPLATE = {
      begin: 'html`',
      end: '',
      starts: {
        end: '`',
        returnEnd: false,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          SUBST
        ],
        subLanguage: 'xml'
      }
    };
    const CSS_TEMPLATE = {
      begin: 'css`',
      end: '',
      starts: {
        end: '`',
        returnEnd: false,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          SUBST
        ],
        subLanguage: 'css'
      }
    };
    const TEMPLATE_STRING = {
      className: 'string',
      begin: '`',
      end: '`',
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ]
    };
    const JSDOC_COMMENT = hljs.COMMENT(
      '/\\*\\*',
      '\\*/',
      {
        relevance: 0,
        contains: [
          {
            className: 'doctag',
            begin: '@[A-Za-z]+',
            contains: [
              {
                className: 'type',
                begin: '\\{',
                end: '\\}',
                relevance: 0
              },
              {
                className: 'variable',
                begin: IDENT_RE$1 + '(?=\\s*(-)|$)',
                endsParent: true,
                relevance: 0
              },
              // eat spaces (not newlines) so we can find
              // types or variables
              {
                begin: /(?=[^\n])\s/,
                relevance: 0
              }
            ]
          }
        ]
      }
    );
    const COMMENT = {
      className: "comment",
      variants: [
        JSDOC_COMMENT,
        hljs.C_BLOCK_COMMENT_MODE,
        hljs.C_LINE_COMMENT_MODE
      ]
    };
    const SUBST_INTERNALS = [
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      HTML_TEMPLATE,
      CSS_TEMPLATE,
      TEMPLATE_STRING,
      NUMBER,
      hljs.REGEXP_MODE
    ];
    SUBST.contains = SUBST_INTERNALS
      .concat({
        // we need to pair up {} inside our subst to prevent
        // it from ending too early by matching another }
        begin: /{/,
        end: /}/,
        keywords: KEYWORDS$1,
        contains: [
          "self"
        ].concat(SUBST_INTERNALS)
      });
    const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
    const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
      // eat recursive parens in sub expressions
      {
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS$1,
        contains: ["self"].concat(SUBST_AND_COMMENTS)
      }
    ]);
    const PARAMS = {
      className: 'params',
      begin: /\(/,
      end: /\)/,
      excludeBegin: true,
      excludeEnd: true,
      keywords: KEYWORDS$1,
      contains: PARAMS_CONTAINS
    };

    return {
      name: 'Javascript',
      aliases: ['js', 'jsx', 'mjs', 'cjs'],
      keywords: KEYWORDS$1,
      // this will be extended by TypeScript
      exports: { PARAMS_CONTAINS },
      illegal: /#(?![$_A-z])/,
      contains: [
        hljs.SHEBANG({
          label: "shebang",
          binary: "node",
          relevance: 5
        }),
        {
          label: "use_strict",
          className: 'meta',
          relevance: 10,
          begin: /^\s*['"]use (strict|asm)['"]/
        },
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        HTML_TEMPLATE,
        CSS_TEMPLATE,
        TEMPLATE_STRING,
        COMMENT,
        NUMBER,
        { // object attr container
          begin: concat(/[{,\n]\s*/,
            // we need to look ahead to make sure that we actually have an
            // attribute coming up so we don't steal a comma from a potential
            // "value" container
            //
            // NOTE: this might not work how you think.  We don't actually always
            // enter this mode and stay.  Instead it might merely match `,
            // <comments up next>` and then immediately end after the , because it
            // fails to find any actual attrs. But this still does the job because
            // it prevents the value contain rule from grabbing this instead and
            // prevening this rule from firing when we actually DO have keys.
            lookahead(concat(
              // we also need to allow for multiple possible comments inbetween
              // the first key:value pairing
              /(\/\/.*$)*/,
              /(\/\*(.|\n)*\*\/)*/,
              /\s*/,
              IDENT_RE$1 + '\\s*:'))),
          relevance: 0,
          contains: [
            {
              className: 'attr',
              begin: IDENT_RE$1 + lookahead('\\s*:'),
              relevance: 0
            }
          ]
        },
        { // "value" container
          begin: '(' + hljs.RE_STARTERS_RE + '|\\b(case|return|throw)\\b)\\s*',
          keywords: 'return throw case',
          contains: [
            COMMENT,
            hljs.REGEXP_MODE,
            {
              className: 'function',
              // we have to count the parens to make sure we actually have the
              // correct bounding ( ) before the =>.  There could be any number of
              // sub-expressions inside also surrounded by parens.
              begin: '(\\(' +
              '[^()]*(\\(' +
              '[^()]*(\\(' +
              '[^()]*' +
              '\\))*[^()]*' +
              '\\))*[^()]*' +
              '\\)|' + hljs.UNDERSCORE_IDENT_RE + ')\\s*=>',
              returnBegin: true,
              end: '\\s*=>',
              contains: [
                {
                  className: 'params',
                  variants: [
                    {
                      begin: hljs.UNDERSCORE_IDENT_RE
                    },
                    {
                      className: null,
                      begin: /\(\s*\)/,
                      skip: true
                    },
                    {
                      begin: /\(/,
                      end: /\)/,
                      excludeBegin: true,
                      excludeEnd: true,
                      keywords: KEYWORDS$1,
                      contains: PARAMS_CONTAINS
                    }
                  ]
                }
              ]
            },
            { // could be a comma delimited list of params to a function call
              begin: /,/, relevance: 0
            },
            {
              className: '',
              begin: /\s/,
              end: /\s*/,
              skip: true
            },
            { // JSX
              variants: [
                { begin: FRAGMENT.begin, end: FRAGMENT.end },
                {
                  begin: XML_TAG.begin,
                  // we carefully check the opening tag to see if it truly
                  // is a tag and not a false positive
                  'on:begin': XML_TAG.isTrulyOpeningTag,
                  end: XML_TAG.end
                }
              ],
              subLanguage: 'xml',
              contains: [
                {
                  begin: XML_TAG.begin,
                  end: XML_TAG.end,
                  skip: true,
                  contains: ['self']
                }
              ]
            }
          ],
          relevance: 0
        },
        {
          className: 'function',
          beginKeywords: 'function',
          end: /[{;]/,
          excludeEnd: true,
          keywords: KEYWORDS$1,
          contains: [
            'self',
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
            PARAMS
          ],
          illegal: /%/
        },
        {
          className: 'function',
          // we have to count the parens to make sure we actually have the correct
          // bounding ( ).  There could be any number of sub-expressions inside
          // also surrounded by parens.
          begin: hljs.UNDERSCORE_IDENT_RE +
            '\\(' + // first parens
            '[^()]*(\\(' +
              '[^()]*(\\(' +
                '[^()]*' +
              '\\))*[^()]*' +
            '\\))*[^()]*' +
            '\\)\\s*{', // end parens
          returnBegin:true,
          contains: [
            PARAMS,
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
          ]
        },
        // hack: prevents detection of keywords in some circumstances
        // .keyword()
        // $keyword = x
        {
          variants: [
            { begin: '\\.' + IDENT_RE$1 },
            { begin: '\\$' + IDENT_RE$1 }
          ],
          relevance: 0
        },
        { // ES6 class
          className: 'class',
          beginKeywords: 'class',
          end: /[{;=]/,
          excludeEnd: true,
          illegal: /[:"\[\]]/,
          contains: [
            { beginKeywords: 'extends' },
            hljs.UNDERSCORE_TITLE_MODE
          ]
        },
        {
          begin: /\b(?=constructor)/,
          end: /[\{;]/,
          excludeEnd: true,
          contains: [
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
            'self',
            PARAMS
          ]
        },
        {
          begin: '(get|set)\\s+(?=' + IDENT_RE$1 + '\\()',
          end: /{/,
          keywords: "get set",
          contains: [
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
            { begin: /\(\)/ }, // eat to avoid empty params
            PARAMS
          ]
        },
        {
          begin: /\$[(.]/ // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
        }
      ]
    };
  }

  return javascript;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('json', function () {
  'use strict';

  /*
  Language: JSON
  Description: JSON (JavaScript Object Notation) is a lightweight data-interchange format.
  Author: Ivan Sagalaev <maniac@softwaremaniacs.org>
  Website: http://www.json.org
  Category: common, protocols
  */

  function json(hljs) {
    var LITERALS = {literal: 'true false null'};
    var ALLOWED_COMMENTS = [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ];
    var TYPES = [
      hljs.QUOTE_STRING_MODE,
      hljs.C_NUMBER_MODE
    ];
    var VALUE_CONTAINER = {
      end: ',', endsWithParent: true, excludeEnd: true,
      contains: TYPES,
      keywords: LITERALS
    };
    var OBJECT = {
      begin: '{', end: '}',
      contains: [
        {
          className: 'attr',
          begin: /"/, end: /"/,
          contains: [hljs.BACKSLASH_ESCAPE],
          illegal: '\\n',
        },
        hljs.inherit(VALUE_CONTAINER, {begin: /:/})
      ].concat(ALLOWED_COMMENTS),
      illegal: '\\S'
    };
    var ARRAY = {
      begin: '\\[', end: '\\]',
      contains: [hljs.inherit(VALUE_CONTAINER)], // inherit is a workaround for a bug that makes shared modes with endsWithParent compile only the ending of one of the parents
      illegal: '\\S'
    };
    TYPES.push(OBJECT, ARRAY);
    ALLOWED_COMMENTS.forEach(function(rule) {
      TYPES.push(rule);
    });
    return {
      name: 'JSON',
      contains: TYPES,
      keywords: LITERALS,
      illegal: '\\S'
    };
  }

  return json;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('kotlin', function () {
  'use strict';

  /*
   Language: Kotlin
   Description: Kotlin is an OSS statically typed programming language that targets the JVM, Android, JavaScript and Native.
   Author: Sergey Mashkov <cy6erGn0m@gmail.com>
   Website: https://kotlinlang.org
   Category: common
   */


  function kotlin(hljs) {
    var KEYWORDS = {
      keyword:
        'abstract as val var vararg get set class object open private protected public noinline ' +
        'crossinline dynamic final enum if else do while for when throw try catch finally ' +
        'import package is in fun override companion reified inline lateinit init ' +
        'interface annotation data sealed internal infix operator out by constructor super ' +
        'tailrec where const inner suspend typealias external expect actual',
      built_in:
        'Byte Short Char Int Long Boolean Float Double Void Unit Nothing',
      literal:
        'true false null'
    };
    var KEYWORDS_WITH_LABEL = {
      className: 'keyword',
      begin: /\b(break|continue|return|this)\b/,
      starts: {
        contains: [
          {
            className: 'symbol',
            begin: /@\w+/
          }
        ]
      }
    };
    var LABEL = {
      className: 'symbol', begin: hljs.UNDERSCORE_IDENT_RE + '@'
    };

    // for string templates
    var SUBST = {
      className: 'subst',
      begin: '\\${', end: '}', contains: [hljs.C_NUMBER_MODE]
    };
    var VARIABLE = {
      className: 'variable', begin: '\\$' + hljs.UNDERSCORE_IDENT_RE
    };
    var STRING = {
      className: 'string',
      variants: [
        {
          begin: '"""', end: '"""(?=[^"])',
          contains: [VARIABLE, SUBST]
        },
        // Can't use built-in modes easily, as we want to use STRING in the meta
        // context as 'meta-string' and there's no syntax to remove explicitly set
        // classNames in built-in modes.
        {
          begin: '\'', end: '\'',
          illegal: /\n/,
          contains: [hljs.BACKSLASH_ESCAPE]
        },
        {
          begin: '"', end: '"',
          illegal: /\n/,
          contains: [hljs.BACKSLASH_ESCAPE, VARIABLE, SUBST]
        }
      ]
    };
    SUBST.contains.push(STRING);

    var ANNOTATION_USE_SITE = {
      className: 'meta', begin: '@(?:file|property|field|get|set|receiver|param|setparam|delegate)\\s*:(?:\\s*' + hljs.UNDERSCORE_IDENT_RE + ')?'
    };
    var ANNOTATION = {
      className: 'meta', begin: '@' + hljs.UNDERSCORE_IDENT_RE,
      contains: [
        {
          begin: /\(/, end: /\)/,
          contains: [
            hljs.inherit(STRING, {className: 'meta-string'})
          ]
        }
      ]
    };

    // https://kotlinlang.org/docs/reference/whatsnew11.html#underscores-in-numeric-literals
    // According to the doc above, the number mode of kotlin is the same as java 8,
    // so the code below is copied from java.js
    var KOTLIN_NUMBER_RE = '\\b' +
      '(' +
        '0[bB]([01]+[01_]+[01]+|[01]+)' + // 0b...
        '|' +
        '0[xX]([a-fA-F0-9]+[a-fA-F0-9_]+[a-fA-F0-9]+|[a-fA-F0-9]+)' + // 0x...
        '|' +
        '(' +
          '([\\d]+[\\d_]+[\\d]+|[\\d]+)(\\.([\\d]+[\\d_]+[\\d]+|[\\d]+))?' +
          '|' +
          '\\.([\\d]+[\\d_]+[\\d]+|[\\d]+)' +
        ')' +
        '([eE][-+]?\\d+)?' + // octal, decimal, float
      ')' +
      '[lLfF]?';
    var KOTLIN_NUMBER_MODE = {
      className: 'number',
      begin: KOTLIN_NUMBER_RE,
      relevance: 0
    };
    var KOTLIN_NESTED_COMMENT = hljs.COMMENT(
      '/\\*', '\\*/',
      { contains: [ hljs.C_BLOCK_COMMENT_MODE ] }
    );
    var KOTLIN_PAREN_TYPE = {
      variants: [
  	  { className: 'type',
  	    begin: hljs.UNDERSCORE_IDENT_RE
  	  },
  	  { begin: /\(/, end: /\)/,
  	    contains: [] //defined later
  	  }
  	]
    };
    var KOTLIN_PAREN_TYPE2 = KOTLIN_PAREN_TYPE;
    KOTLIN_PAREN_TYPE2.variants[1].contains = [ KOTLIN_PAREN_TYPE ];
    KOTLIN_PAREN_TYPE.variants[1].contains = [ KOTLIN_PAREN_TYPE2 ];

    return {
      name: 'Kotlin',
      aliases: ['kt'],
      keywords: KEYWORDS,
      contains : [
        hljs.COMMENT(
          '/\\*\\*',
          '\\*/',
          {
            relevance : 0,
            contains : [{
              className : 'doctag',
              begin : '@[A-Za-z]+'
            }]
          }
        ),
        hljs.C_LINE_COMMENT_MODE,
        KOTLIN_NESTED_COMMENT,
        KEYWORDS_WITH_LABEL,
        LABEL,
        ANNOTATION_USE_SITE,
        ANNOTATION,
        {
          className: 'function',
          beginKeywords: 'fun', end: '[(]|$',
          returnBegin: true,
          excludeEnd: true,
          keywords: KEYWORDS,
          illegal: /fun\s+(<.*>)?[^\s\(]+(\s+[^\s\(]+)\s*=/,
          relevance: 5,
          contains: [
            {
              begin: hljs.UNDERSCORE_IDENT_RE + '\\s*\\(', returnBegin: true,
              relevance: 0,
              contains: [hljs.UNDERSCORE_TITLE_MODE]
            },
            {
              className: 'type',
              begin: /</, end: />/, keywords: 'reified',
              relevance: 0
            },
            {
              className: 'params',
              begin: /\(/, end: /\)/,
              endsParent: true,
              keywords: KEYWORDS,
              relevance: 0,
              contains: [
                {
                  begin: /:/, end: /[=,\/]/, endsWithParent: true,
                  contains: [
                    KOTLIN_PAREN_TYPE,
                    hljs.C_LINE_COMMENT_MODE,
                    KOTLIN_NESTED_COMMENT
                  ],
                  relevance: 0
                },
                hljs.C_LINE_COMMENT_MODE,
                KOTLIN_NESTED_COMMENT,
                ANNOTATION_USE_SITE,
                ANNOTATION,
                STRING,
                hljs.C_NUMBER_MODE
              ]
            },
            KOTLIN_NESTED_COMMENT
          ]
        },
        {
          className: 'class',
          beginKeywords: 'class interface trait', end: /[:\{(]|$/, // remove 'trait' when removed from KEYWORDS
          excludeEnd: true,
          illegal: 'extends implements',
          contains: [
            {beginKeywords: 'public protected internal private constructor'},
            hljs.UNDERSCORE_TITLE_MODE,
            {
              className: 'type',
              begin: /</, end: />/, excludeBegin: true, excludeEnd: true,
              relevance: 0
            },
            {
              className: 'type',
              begin: /[,:]\s*/, end: /[<\(,]|$/, excludeBegin: true, returnEnd: true
            },
            ANNOTATION_USE_SITE,
            ANNOTATION
          ]
        },
        STRING,
        {
          className: 'meta',
          begin: "^#!/usr/bin/env", end: '$',
          illegal: '\n'
        },
        KOTLIN_NUMBER_MODE
      ]
    };
  }

  return kotlin;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('less', function () {
  'use strict';

  /*
  Language: Less
  Description: It's CSS, with just a little more.
  Author:   Max Mikhailov <seven.phases.max@gmail.com>
  Website: http://lesscss.org
  Category: common, css
  */

  function less(hljs) {
    var IDENT_RE        = '[\\w-]+'; // yes, Less identifiers may begin with a digit
    var INTERP_IDENT_RE = '(' + IDENT_RE + '|@{' + IDENT_RE + '})';

    /* Generic Modes */

    var RULES = [], VALUE = []; // forward def. for recursive modes

    var STRING_MODE = function(c) { return {
      // Less strings are not multiline (also include '~' for more consistent coloring of "escaped" strings)
      className: 'string', begin: '~?' + c + '.*?' + c
    };};

    var IDENT_MODE = function(name, begin, relevance) { return {
      className: name, begin: begin, relevance: relevance
    };};

    var PARENS_MODE = {
      // used only to properly balance nested parens inside mixin call, def. arg list
      begin: '\\(', end: '\\)', contains: VALUE, relevance: 0
    };

    // generic Less highlighter (used almost everywhere except selectors):
    VALUE.push(
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      STRING_MODE("'"),
      STRING_MODE('"'),
      hljs.CSS_NUMBER_MODE, // fixme: it does not include dot for numbers like .5em :(
      {
        begin: '(url|data-uri)\\(',
        starts: {className: 'string', end: '[\\)\\n]', excludeEnd: true}
      },
      IDENT_MODE('number', '#[0-9A-Fa-f]+\\b'),
      PARENS_MODE,
      IDENT_MODE('variable', '@@?' + IDENT_RE, 10),
      IDENT_MODE('variable', '@{'  + IDENT_RE + '}'),
      IDENT_MODE('built_in', '~?`[^`]*?`'), // inline javascript (or whatever host language) *multiline* string
      { // @media features (it’s here to not duplicate things in AT_RULE_MODE with extra PARENS_MODE overriding):
        className: 'attribute', begin: IDENT_RE + '\\s*:', end: ':', returnBegin: true, excludeEnd: true
      },
      {
        className: 'meta',
        begin: '!important'
      }
    );

    var VALUE_WITH_RULESETS = VALUE.concat({
      begin: '{', end: '}', contains: RULES
    });

    var MIXIN_GUARD_MODE = {
      beginKeywords: 'when', endsWithParent: true,
      contains: [{beginKeywords: 'and not'}].concat(VALUE) // using this form to override VALUE’s 'function' match
    };

    /* Rule-Level Modes */

    var RULE_MODE = {
      begin: INTERP_IDENT_RE + '\\s*:', returnBegin: true, end: '[;}]',
      relevance: 0,
      contains: [
        {
          className: 'attribute',
          begin: INTERP_IDENT_RE, end: ':', excludeEnd: true,
          starts: {
            endsWithParent: true, illegal: '[<=$]',
            relevance: 0,
            contains: VALUE
          }
        }
      ]
    };

    var AT_RULE_MODE = {
      className: 'keyword',
      begin: '@(import|media|charset|font-face|(-[a-z]+-)?keyframes|supports|document|namespace|page|viewport|host)\\b',
      starts: {end: '[;{}]', returnEnd: true, contains: VALUE, relevance: 0}
    };

    // variable definitions and calls
    var VAR_RULE_MODE = {
      className: 'variable',
      variants: [
        // using more strict pattern for higher relevance to increase chances of Less detection.
        // this is *the only* Less specific statement used in most of the sources, so...
        // (we’ll still often loose to the css-parser unless there's '//' comment,
        // simply because 1 variable just can't beat 99 properties :)
        {begin: '@' + IDENT_RE + '\\s*:', relevance: 15},
        {begin: '@' + IDENT_RE}
      ],
      starts: {end: '[;}]', returnEnd: true, contains: VALUE_WITH_RULESETS}
    };

    var SELECTOR_MODE = {
      // first parse unambiguous selectors (i.e. those not starting with tag)
      // then fall into the scary lookahead-discriminator variant.
      // this mode also handles mixin definitions and calls
      variants: [{
        begin: '[\\.#:&\\[>]', end: '[;{}]'  // mixin calls end with ';'
        }, {
        begin: INTERP_IDENT_RE, end: '{'
      }],
      returnBegin: true,
      returnEnd:   true,
      illegal: '[<=\'$"]',
      relevance: 0,
      contains: [
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        MIXIN_GUARD_MODE,
        IDENT_MODE('keyword',  'all\\b'),
        IDENT_MODE('variable', '@{'  + IDENT_RE + '}'),     // otherwise it’s identified as tag
        IDENT_MODE('selector-tag',  INTERP_IDENT_RE + '%?', 0), // '%' for more consistent coloring of @keyframes "tags"
        IDENT_MODE('selector-id', '#' + INTERP_IDENT_RE),
        IDENT_MODE('selector-class', '\\.' + INTERP_IDENT_RE, 0),
        IDENT_MODE('selector-tag',  '&', 0),
        {className: 'selector-attr', begin: '\\[', end: '\\]'},
        {className: 'selector-pseudo', begin: /:(:)?[a-zA-Z0-9\_\-\+\(\)"'.]+/},
        {begin: '\\(', end: '\\)', contains: VALUE_WITH_RULESETS}, // argument list of parametric mixins
        {begin: '!important'} // eat !important after mixin call or it will be colored as tag
      ]
    };

    RULES.push(
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      AT_RULE_MODE,
      VAR_RULE_MODE,
      RULE_MODE,
      SELECTOR_MODE
    );

    return {
      name: 'Less',
      case_insensitive: true,
      illegal: '[=>\'/<($"]',
      contains: RULES
    };
  }

  return less;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('lua', function () {
  'use strict';

  /*
  Language: Lua
  Description: Lua is a powerful, efficient, lightweight, embeddable scripting language.
  Author: Andrew Fedorov <dmmdrs@mail.ru>
  Category: common, scripting
  Website: https://www.lua.org
  */

  function lua(hljs) {
    var OPENING_LONG_BRACKET = '\\[=*\\[';
    var CLOSING_LONG_BRACKET = '\\]=*\\]';
    var LONG_BRACKETS = {
      begin: OPENING_LONG_BRACKET, end: CLOSING_LONG_BRACKET,
      contains: ['self']
    };
    var COMMENTS = [
      hljs.COMMENT('--(?!' + OPENING_LONG_BRACKET + ')', '$'),
      hljs.COMMENT(
        '--' + OPENING_LONG_BRACKET,
        CLOSING_LONG_BRACKET,
        {
          contains: [LONG_BRACKETS],
          relevance: 10
        }
      )
    ];
    return {
      name: 'Lua',
      keywords: {
        $pattern: hljs.UNDERSCORE_IDENT_RE,
        literal: "true false nil",
        keyword: "and break do else elseif end for goto if in local not or repeat return then until while",
        built_in:
          //Metatags and globals:
          '_G _ENV _VERSION __index __newindex __mode __call __metatable __tostring __len ' +
          '__gc __add __sub __mul __div __mod __pow __concat __unm __eq __lt __le assert ' +
          //Standard methods and properties:
          'collectgarbage dofile error getfenv getmetatable ipairs load loadfile loadstring ' +
          'module next pairs pcall print rawequal rawget rawset require select setfenv ' +
          'setmetatable tonumber tostring type unpack xpcall arg self ' +
          //Library methods and properties (one line per library):
          'coroutine resume yield status wrap create running debug getupvalue ' +
          'debug sethook getmetatable gethook setmetatable setlocal traceback setfenv getinfo setupvalue getlocal getregistry getfenv ' +
          'io lines write close flush open output type read stderr stdin input stdout popen tmpfile ' +
          'math log max acos huge ldexp pi cos tanh pow deg tan cosh sinh random randomseed frexp ceil floor rad abs sqrt modf asin min mod fmod log10 atan2 exp sin atan ' +
          'os exit setlocale date getenv difftime remove time clock tmpname rename execute package preload loadlib loaded loaders cpath config path seeall ' +
          'string sub upper len gfind rep find match char dump gmatch reverse byte format gsub lower ' +
          'table setn insert getn foreachi maxn foreach concat sort remove'
      },
      contains: COMMENTS.concat([
        {
          className: 'function',
          beginKeywords: 'function', end: '\\)',
          contains: [
            hljs.inherit(hljs.TITLE_MODE, {begin: '([_a-zA-Z]\\w*\\.)*([_a-zA-Z]\\w*:)?[_a-zA-Z]\\w*'}),
            {
              className: 'params',
              begin: '\\(', endsWithParent: true,
              contains: COMMENTS
            }
          ].concat(COMMENTS)
        },
        hljs.C_NUMBER_MODE,
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        {
          className: 'string',
          begin: OPENING_LONG_BRACKET, end: CLOSING_LONG_BRACKET,
          contains: [LONG_BRACKETS],
          relevance: 5
        }
      ])
    };
  }

  return lua;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('makefile', function () {
  'use strict';

  /*
  Language: Makefile
  Author: Ivan Sagalaev <maniac@softwaremaniacs.org>
  Contributors: Joël Porquet <joel@porquet.org>
  Website: https://www.gnu.org/software/make/manual/html_node/Introduction.html
  Category: common
  */

  function makefile(hljs) {
    /* Variables: simple (eg $(var)) and special (eg $@) */
    var VARIABLE = {
      className: 'variable',
      variants: [
        {
          begin: '\\$\\(' + hljs.UNDERSCORE_IDENT_RE + '\\)',
          contains: [hljs.BACKSLASH_ESCAPE],
        },
        {
          begin: /\$[@%<?\^\+\*]/
        },
      ]
    };
    /* Quoted string with variables inside */
    var QUOTE_STRING = {
      className: 'string',
      begin: /"/, end: /"/,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        VARIABLE,
      ]
    };
    /* Function: $(func arg,...) */
    var FUNC = {
      className: 'variable',
      begin: /\$\([\w-]+\s/, end: /\)/,
      keywords: {
        built_in:
          'subst patsubst strip findstring filter filter-out sort ' +
          'word wordlist firstword lastword dir notdir suffix basename ' +
          'addsuffix addprefix join wildcard realpath abspath error warning ' +
          'shell origin flavor foreach if or and call eval file value',
      },
      contains: [
        VARIABLE,
      ]
    };
    /* Variable assignment */
    var ASSIGNMENT = {
      begin: '^' + hljs.UNDERSCORE_IDENT_RE + '\\s*(?=[:+?]?=)'
    };
    /* Meta targets (.PHONY) */
    var META = {
      className: 'meta',
      begin: /^\.PHONY:/, end: /$/,
      keywords: {
        $pattern: /[\.\w]+/,
        'meta-keyword': '.PHONY'
      }
    };
    /* Targets */
    var TARGET = {
      className: 'section',
      begin: /^[^\s]+:/, end: /$/,
      contains: [VARIABLE,]
    };
    return {
      name: 'Makefile',
      aliases: ['mk', 'mak'],
      keywords: {
        $pattern: /[\w-]+/,
        keyword: 'define endef undefine ifdef ifndef ifeq ifneq else endif ' +
        'include -include sinclude override export unexport private vpath'
      },
      contains: [
        hljs.HASH_COMMENT_MODE,
        VARIABLE,
        QUOTE_STRING,
        FUNC,
        ASSIGNMENT,
        META,
        TARGET,
      ]
    };
  }

  return makefile;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('xml', function () {
  'use strict';

  /*
  Language: HTML, XML
  Website: https://www.w3.org/XML/
  Category: common
  */

  function xml(hljs) {
    var XML_IDENT_RE = '[A-Za-z0-9\\._:-]+';
    var XML_ENTITIES = {
      className: 'symbol',
      begin: '&[a-z]+;|&#[0-9]+;|&#x[a-f0-9]+;'
    };
    var XML_META_KEYWORDS = {
  	  begin: '\\s',
  	  contains:[
  	    {
  	      className: 'meta-keyword',
  	      begin: '#?[a-z_][a-z1-9_-]+',
  	      illegal: '\\n',
        }
  	  ]
    };
    var XML_META_PAR_KEYWORDS = hljs.inherit(XML_META_KEYWORDS, {begin: '\\(', end: '\\)'});
    var APOS_META_STRING_MODE = hljs.inherit(hljs.APOS_STRING_MODE, {className: 'meta-string'});
    var QUOTE_META_STRING_MODE = hljs.inherit(hljs.QUOTE_STRING_MODE, {className: 'meta-string'});
    var TAG_INTERNALS = {
      endsWithParent: true,
      illegal: /</,
      relevance: 0,
      contains: [
        {
          className: 'attr',
          begin: XML_IDENT_RE,
          relevance: 0
        },
        {
          begin: /=\s*/,
          relevance: 0,
          contains: [
            {
              className: 'string',
              endsParent: true,
              variants: [
                {begin: /"/, end: /"/, contains: [XML_ENTITIES]},
                {begin: /'/, end: /'/, contains: [XML_ENTITIES]},
                {begin: /[^\s"'=<>`]+/}
              ]
            }
          ]
        }
      ]
    };
    return {
      name: 'HTML, XML',
      aliases: ['html', 'xhtml', 'rss', 'atom', 'xjb', 'xsd', 'xsl', 'plist', 'wsf', 'svg'],
      case_insensitive: true,
      contains: [
        {
          className: 'meta',
          begin: '<![a-z]', end: '>',
          relevance: 10,
          contains: [
  				  XML_META_KEYWORDS,
  				  QUOTE_META_STRING_MODE,
  				  APOS_META_STRING_MODE,
  					XML_META_PAR_KEYWORDS,
  					{
  					  begin: '\\[', end: '\\]',
  					  contains:[
  						  {
  					      className: 'meta',
  					      begin: '<![a-z]', end: '>',
  					      contains: [
  					        XML_META_KEYWORDS,
  					        XML_META_PAR_KEYWORDS,
  					        QUOTE_META_STRING_MODE,
  					        APOS_META_STRING_MODE
  						    ]
  			        }
  					  ]
  				  }
  				]
        },
        hljs.COMMENT(
          '<!--',
          '-->',
          {
            relevance: 10
          }
        ),
        {
          begin: '<\\!\\[CDATA\\[', end: '\\]\\]>',
          relevance: 10
        },
        XML_ENTITIES,
        {
          className: 'meta',
          begin: /<\?xml/, end: /\?>/, relevance: 10
        },
        {
          className: 'tag',
          /*
          The lookahead pattern (?=...) ensures that 'begin' only matches
          '<style' as a single word, followed by a whitespace or an
          ending braket. The '$' is needed for the lexeme to be recognized
          by hljs.subMode() that tests lexemes outside the stream.
          */
          begin: '<style(?=\\s|>)', end: '>',
          keywords: {name: 'style'},
          contains: [TAG_INTERNALS],
          starts: {
            end: '</style>', returnEnd: true,
            subLanguage: ['css', 'xml']
          }
        },
        {
          className: 'tag',
          // See the comment in the <style tag about the lookahead pattern
          begin: '<script(?=\\s|>)', end: '>',
          keywords: {name: 'script'},
          contains: [TAG_INTERNALS],
          starts: {
            end: '\<\/script\>', returnEnd: true,
            subLanguage: ['javascript', 'handlebars', 'xml']
          }
        },
        {
          className: 'tag',
          begin: '</?', end: '/?>',
          contains: [
            {
              className: 'name', begin: /[^\/><\s]+/, relevance: 0
            },
            TAG_INTERNALS
          ]
        }
      ]
    };
  }

  return xml;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('markdown', function () {
  'use strict';

  /*
  Language: Markdown
  Requires: xml.js
  Author: John Crepezzi <john.crepezzi@gmail.com>
  Website: https://daringfireball.net/projects/markdown/
  Category: common, markup
  */

  function markdown(hljs) {
    const INLINE_HTML = {
      begin: '<', end: '>',
      subLanguage: 'xml',
      relevance: 0
    };
    const HORIZONTAL_RULE = {
      begin: '^[-\\*]{3,}', end: '$'
    };
    const CODE = {
      className: 'code',
      variants: [
        // TODO: fix to allow these to work with sublanguage also
        { begin: '(`{3,})(.|\\n)*?\\1`*[ ]*', },
        { begin: '(~{3,})(.|\\n)*?\\1~*[ ]*', },
        // needed to allow markdown as a sublanguage to work
        { begin: '```', end: '```+[ ]*$' },
        { begin: '~~~', end: '~~~+[ ]*$' },
        { begin: '`.+?`' },
        {
          begin: '(?=^( {4}|\\t))',
          // use contains to gobble up multiple lines to allow the block to be whatever size
          // but only have a single open/close tag vs one per line
          contains: [
            { begin: '^( {4}|\\t)', end: '(\\n)$' }
          ],
          relevance: 0
        }
      ]
    };
    const LIST = {
      className: 'bullet',
      begin: '^[ \t]*([*+-]|(\\d+\\.))(?=\\s+)',
      end: '\\s+',
      excludeEnd: true
    };
    const LINK_REFERENCE = {
      begin: /^\[[^\n]+\]:/,
      returnBegin: true,
      contains: [
        {
          className: 'symbol',
          begin: /\[/, end: /\]/,
          excludeBegin: true, excludeEnd: true
        },
        {
          className: 'link',
          begin: /:\s*/, end: /$/,
          excludeBegin: true
        }
      ]
    };
    const LINK = {
      begin: '\\[.+?\\][\\(\\[].*?[\\)\\]]',
      returnBegin: true,
      contains: [
        {
          className: 'string',
          begin: '\\[', end: '\\]',
          excludeBegin: true,
          returnEnd: true,
          relevance: 0
        },
        {
          className: 'link',
          begin: '\\]\\(', end: '\\)',
          excludeBegin: true, excludeEnd: true
        },
        {
          className: 'symbol',
          begin: '\\]\\[', end: '\\]',
          excludeBegin: true, excludeEnd: true
        }
      ],
      relevance: 10
    };
    const BOLD = {
      className: 'strong',
      contains: [],
      variants: [
        {begin: /_{2}/, end: /_{2}/ },
        {begin: /\*{2}/, end: /\*{2}/ }
      ]
    };
    const ITALIC = {
      className: 'emphasis',
      contains: [],
      variants: [
        { begin: /\*(?!\*)/, end: /\*/ },
        { begin: /_(?!_)/, end: /_/, relevance: 0},
      ]
    };
    BOLD.contains.push(ITALIC);
    ITALIC.contains.push(BOLD);

    var CONTAINABLE = [
      INLINE_HTML,
      LINK
    ];

    BOLD.contains = BOLD.contains.concat(CONTAINABLE);
    ITALIC.contains = ITALIC.contains.concat(CONTAINABLE);

    CONTAINABLE = CONTAINABLE.concat(BOLD,ITALIC);

    const HEADER = {
      className: 'section',
      variants: [
        {
          begin: '^#{1,6}',
          end: '$',
          contains: CONTAINABLE
         },
        {
          begin: '(?=^.+?\\n[=-]{2,}$)',
          contains: [
            { begin: '^[=-]*$' },
            { begin: '^', end: "\\n", contains: CONTAINABLE },
          ]
         }
      ]
    };

    const BLOCKQUOTE = {
      className: 'quote',
      begin: '^>\\s+',
      contains: CONTAINABLE,
      end: '$',
    };

    return {
      name: 'Markdown',
      aliases: ['md', 'mkdown', 'mkd'],
      contains: [
        HEADER,
        INLINE_HTML,
        LIST,
        BOLD,
        ITALIC,
        BLOCKQUOTE,
        CODE,
        HORIZONTAL_RULE,
        LINK,
        LINK_REFERENCE
      ]
    };
  }

  return markdown;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('nginx', function () {
  'use strict';

  /*
  Language: Nginx config
  Author: Peter Leonov <gojpeg@yandex.ru>
  Contributors: Ivan Sagalaev <maniac@softwaremaniacs.org>
  Category: common, config
  Website: https://www.nginx.com
  */

  function nginx(hljs) {
    var VAR = {
      className: 'variable',
      variants: [
        {begin: /\$\d+/},
        {begin: /\$\{/, end: /}/},
        {begin: '[\\$\\@]' + hljs.UNDERSCORE_IDENT_RE}
      ]
    };
    var DEFAULT = {
      endsWithParent: true,
      keywords: {
        $pattern: '[a-z/_]+',
        literal:
          'on off yes no true false none blocked debug info notice warn error crit ' +
          'select break last permanent redirect kqueue rtsig epoll poll /dev/poll'
      },
      relevance: 0,
      illegal: '=>',
      contains: [
        hljs.HASH_COMMENT_MODE,
        {
          className: 'string',
          contains: [hljs.BACKSLASH_ESCAPE, VAR],
          variants: [
            {begin: /"/, end: /"/},
            {begin: /'/, end: /'/}
          ]
        },
        // this swallows entire URLs to avoid detecting numbers within
        {
          begin: '([a-z]+):/', end: '\\s', endsWithParent: true, excludeEnd: true,
          contains: [VAR]
        },
        {
          className: 'regexp',
          contains: [hljs.BACKSLASH_ESCAPE, VAR],
          variants: [
            {begin: "\\s\\^", end: "\\s|{|;", returnEnd: true},
            // regexp locations (~, ~*)
            {begin: "~\\*?\\s+", end: "\\s|{|;", returnEnd: true},
            // *.example.com
            {begin: "\\*(\\.[a-z\\-]+)+"},
            // sub.example.*
            {begin: "([a-z\\-]+\\.)+\\*"}
          ]
        },
        // IP
        {
          className: 'number',
          begin: '\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(:\\d{1,5})?\\b'
        },
        // units
        {
          className: 'number',
          begin: '\\b\\d+[kKmMgGdshdwy]*\\b',
          relevance: 0
        },
        VAR
      ]
    };

    return {
      name: 'Nginx config',
      aliases: ['nginxconf'],
      contains: [
        hljs.HASH_COMMENT_MODE,
        {
          begin: hljs.UNDERSCORE_IDENT_RE + '\\s+{', returnBegin: true,
          end: '{',
          contains: [
            {
              className: 'section',
              begin: hljs.UNDERSCORE_IDENT_RE
            }
          ],
          relevance: 0
        },
        {
          begin: hljs.UNDERSCORE_IDENT_RE + '\\s', end: ';|{', returnBegin: true,
          contains: [
            {
              className: 'attribute',
              begin: hljs.UNDERSCORE_IDENT_RE,
              starts: DEFAULT
            }
          ],
          relevance: 0
        }
      ],
      illegal: '[^\\s\\}]'
    };
  }

  return nginx;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('objectivec', function () {
  'use strict';

  /*
  Language: Objective-C
  Author: Valerii Hiora <valerii.hiora@gmail.com>
  Contributors: Angel G. Olloqui <angelgarcia.mail@gmail.com>, Matt Diephouse <matt@diephouse.com>, Andrew Farmer <ahfarmer@gmail.com>, Minh Nguyễn <mxn@1ec5.org>
  Website: https://developer.apple.com/documentation/objectivec
  Category: common
  */

  function objectivec(hljs) {
    var API_CLASS = {
      className: 'built_in',
      begin: '\\b(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)\\w+',
    };
    var IDENTIFIER_RE = /[a-zA-Z@][a-zA-Z0-9_]*/;
    var OBJC_KEYWORDS = {
      $pattern: IDENTIFIER_RE,
      keyword:
        'int float while char export sizeof typedef const struct for union ' +
        'unsigned long volatile static bool mutable if do return goto void ' +
        'enum else break extern asm case short default double register explicit ' +
        'signed typename this switch continue wchar_t inline readonly assign ' +
        'readwrite self @synchronized id typeof ' +
        'nonatomic super unichar IBOutlet IBAction strong weak copy ' +
        'in out inout bycopy byref oneway __strong __weak __block __autoreleasing ' +
        '@private @protected @public @try @property @end @throw @catch @finally ' +
        '@autoreleasepool @synthesize @dynamic @selector @optional @required ' +
        '@encode @package @import @defs @compatibility_alias ' +
        '__bridge __bridge_transfer __bridge_retained __bridge_retain ' +
        '__covariant __contravariant __kindof ' +
        '_Nonnull _Nullable _Null_unspecified ' +
        '__FUNCTION__ __PRETTY_FUNCTION__ __attribute__ ' +
        'getter setter retain unsafe_unretained ' +
        'nonnull nullable null_unspecified null_resettable class instancetype ' +
        'NS_DESIGNATED_INITIALIZER NS_UNAVAILABLE NS_REQUIRES_SUPER ' +
        'NS_RETURNS_INNER_POINTER NS_INLINE NS_AVAILABLE NS_DEPRECATED ' +
        'NS_ENUM NS_OPTIONS NS_SWIFT_UNAVAILABLE ' +
        'NS_ASSUME_NONNULL_BEGIN NS_ASSUME_NONNULL_END ' +
        'NS_REFINED_FOR_SWIFT NS_SWIFT_NAME NS_SWIFT_NOTHROW ' +
        'NS_DURING NS_HANDLER NS_ENDHANDLER NS_VALUERETURN NS_VOIDRETURN',
      literal:
        'false true FALSE TRUE nil YES NO NULL',
      built_in:
        'BOOL dispatch_once_t dispatch_queue_t dispatch_sync dispatch_async dispatch_once'
    };
    var CLASS_KEYWORDS = {
      $pattern: IDENTIFIER_RE,
      keyword: '@interface @class @protocol @implementation'
    };
    return {
      name: 'Objective-C',
      aliases: ['mm', 'objc', 'obj-c', 'obj-c++', 'objective-c++'],
      keywords: OBJC_KEYWORDS,
      illegal: '</',
      contains: [
        API_CLASS,
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        hljs.C_NUMBER_MODE,
        hljs.QUOTE_STRING_MODE,
        hljs.APOS_STRING_MODE,
        {
          className: 'string',
          variants: [
            {
              begin: '@"', end: '"',
              illegal: '\\n',
              contains: [hljs.BACKSLASH_ESCAPE]
            }
          ]
        },
        {
          className: 'meta',
          begin: /#\s*[a-z]+\b/, end: /$/,
          keywords: {
            'meta-keyword':
              'if else elif endif define undef warning error line ' +
              'pragma ifdef ifndef include'
          },
          contains: [
            {
              begin: /\\\n/, relevance: 0
            },
            hljs.inherit(hljs.QUOTE_STRING_MODE, {className: 'meta-string'}),
            {
              className: 'meta-string',
              begin: /<.*?>/, end: /$/,
              illegal: '\\n',
            },
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE
          ]
        },
        {
          className: 'class',
          begin: '(' + CLASS_KEYWORDS.keyword.split(' ').join('|') + ')\\b', end: '({|$)', excludeEnd: true,
          keywords: CLASS_KEYWORDS,
          contains: [
            hljs.UNDERSCORE_TITLE_MODE
          ]
        },
        {
          begin: '\\.'+hljs.UNDERSCORE_IDENT_RE,
          relevance: 0
        }
      ]
    };
  }

  return objectivec;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('perl', function () {
  'use strict';

  /*
  Language: Perl
  Author: Peter Leonov <gojpeg@yandex.ru>
  Website: https://www.perl.org
  Category: common
  */

  function perl(hljs) {
    var PERL_KEYWORDS = {
      $pattern: /[\w.]+/,
      keyword: 'getpwent getservent quotemeta msgrcv scalar kill dbmclose undef lc ' +
      'ma syswrite tr send umask sysopen shmwrite vec qx utime local oct semctl localtime ' +
      'readpipe do return format read sprintf dbmopen pop getpgrp not getpwnam rewinddir qq ' +
      'fileno qw endprotoent wait sethostent bless s|0 opendir continue each sleep endgrent ' +
      'shutdown dump chomp connect getsockname die socketpair close flock exists index shmget ' +
      'sub for endpwent redo lstat msgctl setpgrp abs exit select print ref gethostbyaddr ' +
      'unshift fcntl syscall goto getnetbyaddr join gmtime symlink semget splice x|0 ' +
      'getpeername recv log setsockopt cos last reverse gethostbyname getgrnam study formline ' +
      'endhostent times chop length gethostent getnetent pack getprotoent getservbyname rand ' +
      'mkdir pos chmod y|0 substr endnetent printf next open msgsnd readdir use unlink ' +
      'getsockopt getpriority rindex wantarray hex system getservbyport endservent int chr ' +
      'untie rmdir prototype tell listen fork shmread ucfirst setprotoent else sysseek link ' +
      'getgrgid shmctl waitpid unpack getnetbyname reset chdir grep split require caller ' +
      'lcfirst until warn while values shift telldir getpwuid my getprotobynumber delete and ' +
      'sort uc defined srand accept package seekdir getprotobyname semop our rename seek if q|0 ' +
      'chroot sysread setpwent no crypt getc chown sqrt write setnetent setpriority foreach ' +
      'tie sin msgget map stat getlogin unless elsif truncate exec keys glob tied closedir ' +
      'ioctl socket readlink eval xor readline binmode setservent eof ord bind alarm pipe ' +
      'atan2 getgrent exp time push setgrent gt lt or ne m|0 break given say state when'
    };
    var SUBST = {
      className: 'subst',
      begin: '[$@]\\{', end: '\\}',
      keywords: PERL_KEYWORDS
    };
    var METHOD = {
      begin: '->{', end: '}'
      // contains defined later
    };
    var VAR = {
      variants: [
        {begin: /\$\d/},
        {begin: /[\$%@](\^\w\b|#\w+(::\w+)*|{\w+}|\w+(::\w*)*)/},
        {begin: /[\$%@][^\s\w{]/, relevance: 0}
      ]
    };
    var STRING_CONTAINS = [hljs.BACKSLASH_ESCAPE, SUBST, VAR];
    var PERL_DEFAULT_CONTAINS = [
      VAR,
      hljs.HASH_COMMENT_MODE,
      hljs.COMMENT(
        '^\\=\\w',
        '\\=cut',
        {
          endsWithParent: true
        }
      ),
      METHOD,
      {
        className: 'string',
        contains: STRING_CONTAINS,
        variants: [
          {
            begin: 'q[qwxr]?\\s*\\(', end: '\\)',
            relevance: 5
          },
          {
            begin: 'q[qwxr]?\\s*\\[', end: '\\]',
            relevance: 5
          },
          {
            begin: 'q[qwxr]?\\s*\\{', end: '\\}',
            relevance: 5
          },
          {
            begin: 'q[qwxr]?\\s*\\|', end: '\\|',
            relevance: 5
          },
          {
            begin: 'q[qwxr]?\\s*\\<', end: '\\>',
            relevance: 5
          },
          {
            begin: 'qw\\s+q', end: 'q',
            relevance: 5
          },
          {
            begin: '\'', end: '\'',
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          {
            begin: '"', end: '"'
          },
          {
            begin: '`', end: '`',
            contains: [hljs.BACKSLASH_ESCAPE]
          },
          {
            begin: '{\\w+}',
            contains: [],
            relevance: 0
          },
          {
            begin: '\-?\\w+\\s*\\=\\>',
            contains: [],
            relevance: 0
          }
        ]
      },
      {
        className: 'number',
        begin: '(\\b0[0-7_]+)|(\\b0x[0-9a-fA-F_]+)|(\\b[1-9][0-9_]*(\\.[0-9_]+)?)|[0_]\\b',
        relevance: 0
      },
      { // regexp container
        begin: '(\\/\\/|' + hljs.RE_STARTERS_RE + '|\\b(split|return|print|reverse|grep)\\b)\\s*',
        keywords: 'split return print reverse grep',
        relevance: 0,
        contains: [
          hljs.HASH_COMMENT_MODE,
          {
            className: 'regexp',
            begin: '(s|tr|y)/(\\\\.|[^/])*/(\\\\.|[^/])*/[a-z]*',
            relevance: 10
          },
          {
            className: 'regexp',
            begin: '(m|qr)?/', end: '/[a-z]*',
            contains: [hljs.BACKSLASH_ESCAPE],
            relevance: 0 // allows empty "//" which is a common comment delimiter in other languages
          }
        ]
      },
      {
        className: 'function',
        beginKeywords: 'sub', end: '(\\s*\\(.*?\\))?[;{]', excludeEnd: true,
        relevance: 5,
        contains: [hljs.TITLE_MODE]
      },
      {
        begin: '-\\w\\b',
        relevance: 0
      },
      {
        begin: "^__DATA__$",
        end: "^__END__$",
        subLanguage: 'mojolicious',
        contains: [
          {
              begin: "^@@.*",
              end: "$",
              className: "comment"
          }
        ]
      }
    ];
    SUBST.contains = PERL_DEFAULT_CONTAINS;
    METHOD.contains = PERL_DEFAULT_CONTAINS;

    return {
      name: 'Perl',
      aliases: ['pl', 'pm'],
      keywords: PERL_KEYWORDS,
      contains: PERL_DEFAULT_CONTAINS
    };
  }

  return perl;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('php', function () {
  'use strict';

  /*
  Language: PHP
  Author: Victor Karamzin <Victor.Karamzin@enterra-inc.com>
  Contributors: Evgeny Stepanischev <imbolk@gmail.com>, Ivan Sagalaev <maniac@softwaremaniacs.org>
  Website: https://www.php.net
  Category: common
  */

  /**
   * @param {HLJSApi} hljs
   * @returns {LanguageDetail}
   * */
  function php(hljs) {
    var VARIABLE = {
      begin: '\\$+[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*'
    };
    var PREPROCESSOR = {
      className: 'meta',
      variants: [
        { begin: /<\?php/, relevance: 10 }, // boost for obvious PHP
        { begin: /<\?[=]?/ },
        { begin: /\?>/ } // end php tag
      ]
    };
    var SUBST = {
      className: 'subst',
      variants: [
        { begin: /\$\w+/ },
        { begin: /\{\$/, end: /\}/ }
      ]
    };
    var SINGLE_QUOTED = hljs.inherit(hljs.APOS_STRING_MODE, {
      illegal: null,
    });
    var DOUBLE_QUOTED = hljs.inherit(hljs.QUOTE_STRING_MODE, {
      illegal: null,
      contains: hljs.QUOTE_STRING_MODE.contains.concat(SUBST),
    });
    var HEREDOC = hljs.END_SAME_AS_BEGIN({
      begin: /<<<[ \t]*(\w+)\n/,
      end: /[ \t]*(\w+)\b/,
      contains: hljs.QUOTE_STRING_MODE.contains.concat(SUBST),
    });
    var STRING = {
      className: 'string',
      contains: [hljs.BACKSLASH_ESCAPE, PREPROCESSOR],
      variants: [
        hljs.inherit(SINGLE_QUOTED, {
          begin: "b'", end: "'",
        }),
        hljs.inherit(DOUBLE_QUOTED, {
          begin: 'b"', end: '"',
        }),
        DOUBLE_QUOTED,
        SINGLE_QUOTED,
        HEREDOC
      ]
    };
    var NUMBER = {variants: [hljs.BINARY_NUMBER_MODE, hljs.C_NUMBER_MODE]};
    var KEYWORDS = {
      keyword:
      // Magic constants:
      // <https://www.php.net/manual/en/language.constants.predefined.php>
      '__CLASS__ __DIR__ __FILE__ __FUNCTION__ __LINE__ __METHOD__ __NAMESPACE__ __TRAIT__ ' +
      // Function that look like language construct or language construct that look like function:
      // List of keywords that may not require parenthesis
      'die echo exit include include_once print require require_once ' +
      // These are not language construct (function) but operate on the currently-executing function and can access the current symbol table
      // 'compact extract func_get_arg func_get_args func_num_args get_called_class get_parent_class ' +
      // Other keywords:
      // <https://www.php.net/manual/en/reserved.php>
      // <https://www.php.net/manual/en/language.types.type-juggling.php>
      'array abstract and as binary bool boolean break callable case catch class clone const continue declare default do double else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval extends final finally float for foreach from global goto if implements instanceof insteadof int integer interface isset iterable list match new object or private protected public real return string switch throw trait try unset use var void while xor yield',
      literal: 'false null true',
      built_in:
      // Standard PHP library:
      // <https://www.php.net/manual/en/book.spl.php>
      'Error|0 ' + // error is too common a name esp since PHP is case in-sensitive
      'AppendIterator ArgumentCountError ArithmeticError ArrayIterator ArrayObject AssertionError BadFunctionCallException BadMethodCallException CachingIterator CallbackFilterIterator CompileError Countable DirectoryIterator DivisionByZeroError DomainException EmptyIterator ErrorException Exception FilesystemIterator FilterIterator GlobIterator InfiniteIterator InvalidArgumentException IteratorIterator LengthException LimitIterator LogicException MultipleIterator NoRewindIterator OutOfBoundsException OutOfRangeException OuterIterator OverflowException ParentIterator ParseError RangeException RecursiveArrayIterator RecursiveCachingIterator RecursiveCallbackFilterIterator RecursiveDirectoryIterator RecursiveFilterIterator RecursiveIterator RecursiveIteratorIterator RecursiveRegexIterator RecursiveTreeIterator RegexIterator RuntimeException SeekableIterator SplDoublyLinkedList SplFileInfo SplFileObject SplFixedArray SplHeap SplMaxHeap SplMinHeap SplObjectStorage SplObserver SplObserver SplPriorityQueue SplQueue SplStack SplSubject SplSubject SplTempFileObject TypeError UnderflowException UnexpectedValueException ' +
      // Reserved interfaces:
      // <https://www.php.net/manual/en/reserved.interfaces.php>
      'ArrayAccess Closure Generator Iterator IteratorAggregate Serializable Throwable Traversable WeakReference ' +
      // Reserved classes:
      // <https://www.php.net/manual/en/reserved.classes.php>
      'Directory __PHP_Incomplete_Class parent php_user_filter self static stdClass'
    };
    return {
      aliases: ['php', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8'],
      case_insensitive: true,
      keywords: KEYWORDS,
      contains: [
        hljs.HASH_COMMENT_MODE,
        hljs.COMMENT('//', '$', {contains: [PREPROCESSOR]}),
        hljs.COMMENT(
          '/\\*',
          '\\*/',
          {
            contains: [
              {
                className: 'doctag',
                begin: '@[A-Za-z]+'
              }
            ]
          }
        ),
        hljs.COMMENT(
          '__halt_compiler.+?;',
          false,
          {
            endsWithParent: true,
            keywords: '__halt_compiler'
          }
        ),
        PREPROCESSOR,
        {
          className: 'keyword', begin: /\$this\b/
        },
        VARIABLE,
        {
          // swallow composed identifiers to avoid parsing them as keywords
          begin: /(::|->)+[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*/
        },
        {
          className: 'function',
          beginKeywords: 'fn function', end: /[;{]/, excludeEnd: true,
          illegal: '[$%\\[]',
          contains: [
            hljs.UNDERSCORE_TITLE_MODE,
            {
              className: 'params',
              begin: '\\(', end: '\\)',
              excludeBegin: true,
              excludeEnd: true,
              keywords: KEYWORDS,
              contains: [
                'self',
                VARIABLE,
                hljs.C_BLOCK_COMMENT_MODE,
                STRING,
                NUMBER
              ]
            }
          ]
        },
        {
          className: 'class',
          beginKeywords: 'class interface', end: '{', excludeEnd: true,
          illegal: /[:\(\$"]/,
          contains: [
            {beginKeywords: 'extends implements'},
            hljs.UNDERSCORE_TITLE_MODE
          ]
        },
        {
          beginKeywords: 'namespace', end: ';',
          illegal: /[\.']/,
          contains: [hljs.UNDERSCORE_TITLE_MODE]
        },
        {
          beginKeywords: 'use', end: ';',
          contains: [hljs.UNDERSCORE_TITLE_MODE]
        },
        {
          begin: '=>' // No markup, just a relevance booster
        },
        STRING,
        NUMBER
      ]
    };
  }

  return php;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('php-template', function () {
  'use strict';

  /*
  Language: PHP Template
  Requires: xml.js, php.js
  Author: Josh Goebel <hello@joshgoebel.com>
  Website: https://www.php.net
  Category: common
  */

  function phpTemplate(hljs) {
    return {
      name: "PHP template",
      subLanguage: 'xml',
      contains: [
        {
          begin: /<\?(php|=)?/,
          end: /\?>/,
          subLanguage: 'php',
          contains: [
            // We don't want the php closing tag ?> to close the PHP block when
            // inside any of the following blocks:
            {begin: '/\\*', end: '\\*/', skip: true},
            {begin: 'b"', end: '"', skip: true},
            {begin: 'b\'', end: '\'', skip: true},
            hljs.inherit(hljs.APOS_STRING_MODE, {illegal: null, className: null, contains: null, skip: true}),
            hljs.inherit(hljs.QUOTE_STRING_MODE, {illegal: null, className: null, contains: null, skip: true})
          ]
        }
      ]
    };
  }

  return phpTemplate;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('plaintext', function () {
    'use strict';

    /*
    Language: Plain text
    Author: Egor Rogov (e.rogov@postgrespro.ru)
    Description: Plain text without any highlighting.
    Category: common
    */

    function plaintext(hljs) {
        return {
            name: 'Plain text',
            aliases: ['text', 'txt'],
            disableAutodetect: true
        };
    }

    return plaintext;

    return module.exports.definer || module.exports;

}());

hljs.registerLanguage('properties', function () {
  'use strict';

  /*
  Language: .properties
  Contributors: Valentin Aitken <valentin@nalisbg.com>, Egor Rogov <e.rogov@postgrespro.ru>
  Website: https://en.wikipedia.org/wiki/.properties
  Category: common, config
  */

  function properties(hljs) {

    // whitespaces: space, tab, formfeed
    var WS0 = '[ \\t\\f]*';
    var WS1 = '[ \\t\\f]+';
    // delimiter
    var DELIM = '(' + WS0+'[:=]'+WS0+ '|' + WS1 + ')';
    var KEY_ALPHANUM = '([^\\\\\\W:= \\t\\f\\n]|\\\\.)+';
    var KEY_OTHER = '([^\\\\:= \\t\\f\\n]|\\\\.)+';

    var DELIM_AND_VALUE = {
            // skip DELIM
            end: DELIM,
            relevance: 0,
            starts: {
              // value: everything until end of line (again, taking into account backslashes)
              className: 'string',
              end: /$/,
              relevance: 0,
              contains: [
                { begin: '\\\\\\n' }
              ]
            }
          };

    return {
      name: '.properties',
      case_insensitive: true,
      illegal: /\S/,
      contains: [
        hljs.COMMENT('^\\s*[!#]', '$'),
        // key: everything until whitespace or = or : (taking into account backslashes)
        // case of a "normal" key
        {
          begin: KEY_ALPHANUM + DELIM,
          returnBegin: true,
          contains: [
            {
              className: 'attr',
              begin: KEY_ALPHANUM,
              endsParent: true,
              relevance: 0
            }
          ],
          starts: DELIM_AND_VALUE
        },
        // case of key containing non-alphanumeric chars => relevance = 0
        {
          begin: KEY_OTHER + DELIM,
          returnBegin: true,
          relevance: 0,
          contains: [
            {
              className: 'meta',
              begin: KEY_OTHER,
              endsParent: true,
              relevance: 0
            }
          ],
          starts: DELIM_AND_VALUE
        },
        // case of an empty key
        {
          className: 'attr',
          relevance: 0,
          begin: KEY_OTHER + WS0 + '$'
        }
      ]
    };
  }

  return properties;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('python-repl', function () {
  'use strict';

  /*
  Language: Python REPL
  Requires: python.js
  Author: Josh Goebel <hello@joshgoebel.com>
  Category: common
  */

  function pythonRepl(hljs) {
    return {
      aliases: ['pycon'],
      contains: [
        {
          className: 'meta',
          starts: {
            // a space separates the REPL prefix from the actual code
            // this is purely for cleaner HTML output
            end: / |$/,
            starts: {
              end: '$', subLanguage: 'python'
            }
          },
          variants: [
            { begin: /^>>>(?=[ ]|$)/ },
            { begin: /^\.\.\.(?=[ ]|$)/ }
          ]
        },
      ]
    }
  }

  return pythonRepl;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('ruby', function () {
  'use strict';

  /*
  Language: Ruby
  Description: Ruby is a dynamic, open source programming language with a focus on simplicity and productivity.
  Website: https://www.ruby-lang.org/
  Author: Anton Kovalyov <anton@kovalyov.net>
  Contributors: Peter Leonov <gojpeg@yandex.ru>, Vasily Polovnyov <vast@whiteants.net>, Loren Segal <lsegal@soen.ca>, Pascal Hurni <phi@ruby-reactive.org>, Cedric Sohrauer <sohrauer@googlemail.com>
  Category: common
  */

  function ruby(hljs) {
    var RUBY_METHOD_RE = '[a-zA-Z_]\\w*[!?=]?|[-+~]\\@|<<|>>|=~|===?|<=>|[<>]=?|\\*\\*|[-/+%^&*~`|]|\\[\\]=?';
    var RUBY_KEYWORDS = {
      keyword:
        'and then defined module in return redo if BEGIN retry end for self when ' +
        'next until do begin unless END rescue else break undef not super class case ' +
        'require yield alias while ensure elsif or include attr_reader attr_writer attr_accessor',
      literal:
        'true false nil'
    };
    var YARDOCTAG = {
      className: 'doctag',
      begin: '@[A-Za-z]+'
    };
    var IRB_OBJECT = {
      begin: '#<', end: '>'
    };
    var COMMENT_MODES = [
      hljs.COMMENT(
        '#',
        '$',
        {
          contains: [YARDOCTAG]
        }
      ),
      hljs.COMMENT(
        '^\\=begin',
        '^\\=end',
        {
          contains: [YARDOCTAG],
          relevance: 10
        }
      ),
      hljs.COMMENT('^__END__', '\\n$')
    ];
    var SUBST = {
      className: 'subst',
      begin: '#\\{', end: '}',
      keywords: RUBY_KEYWORDS
    };
    var STRING = {
      className: 'string',
      contains: [hljs.BACKSLASH_ESCAPE, SUBST],
      variants: [
        {begin: /'/, end: /'/},
        {begin: /"/, end: /"/},
        {begin: /`/, end: /`/},
        {begin: '%[qQwWx]?\\(', end: '\\)'},
        {begin: '%[qQwWx]?\\[', end: '\\]'},
        {begin: '%[qQwWx]?{', end: '}'},
        {begin: '%[qQwWx]?<', end: '>'},
        {begin: '%[qQwWx]?/', end: '/'},
        {begin: '%[qQwWx]?%', end: '%'},
        {begin: '%[qQwWx]?-', end: '-'},
        {begin: '%[qQwWx]?\\|', end: '\\|'},
        {
          // \B in the beginning suppresses recognition of ?-sequences where ?
          // is the last character of a preceding identifier, as in: `func?4`
          begin: /\B\?(\\\d{1,3}|\\x[A-Fa-f0-9]{1,2}|\\u[A-Fa-f0-9]{4}|\\?\S)\b/
        },
        { // heredocs
          begin: /<<[-~]?'?(\w+)(?:.|\n)*?\n\s*\1\b/,
          returnBegin: true,
          contains: [
            { begin: /<<[-~]?'?/ },
            hljs.END_SAME_AS_BEGIN({
              begin: /(\w+)/, end: /(\w+)/,
              contains: [hljs.BACKSLASH_ESCAPE, SUBST],
            })
          ]
        }
      ]
    };
    var PARAMS = {
      className: 'params',
      begin: '\\(', end: '\\)', endsParent: true,
      keywords: RUBY_KEYWORDS
    };

    var RUBY_DEFAULT_CONTAINS = [
      STRING,
      IRB_OBJECT,
      {
        className: 'class',
        beginKeywords: 'class module', end: '$|;',
        illegal: /=/,
        contains: [
          hljs.inherit(hljs.TITLE_MODE, {begin: '[A-Za-z_]\\w*(::\\w+)*(\\?|\\!)?'}),
          {
            begin: '<\\s*',
            contains: [{
              begin: '(' + hljs.IDENT_RE + '::)?' + hljs.IDENT_RE
            }]
          }
        ].concat(COMMENT_MODES)
      },
      {
        className: 'function',
        beginKeywords: 'def', end: '$|;',
        contains: [
          hljs.inherit(hljs.TITLE_MODE, {begin: RUBY_METHOD_RE}),
          PARAMS
        ].concat(COMMENT_MODES)
      },
      {
        // swallow namespace qualifiers before symbols
        begin: hljs.IDENT_RE + '::'
      },
      {
        className: 'symbol',
        begin: hljs.UNDERSCORE_IDENT_RE + '(\\!|\\?)?:',
        relevance: 0
      },
      {
        className: 'symbol',
        begin: ':(?!\\s)',
        contains: [STRING, {begin: RUBY_METHOD_RE}],
        relevance: 0
      },
      {
        className: 'number',
        begin: '(\\b0[0-7_]+)|(\\b0x[0-9a-fA-F_]+)|(\\b[1-9][0-9_]*(\\.[0-9_]+)?)|[0_]\\b',
        relevance: 0
      },
      {
        begin: '(\\$\\W)|((\\$|\\@\\@?)(\\w+))' // variables
      },
      {
        className: 'params',
        begin: /\|/, end: /\|/,
        keywords: RUBY_KEYWORDS
      },
      { // regexp container
        begin: '(' + hljs.RE_STARTERS_RE + '|unless)\\s*',
        keywords: 'unless',
        contains: [
          IRB_OBJECT,
          {
            className: 'regexp',
            contains: [hljs.BACKSLASH_ESCAPE, SUBST],
            illegal: /\n/,
            variants: [
              {begin: '/', end: '/[a-z]*'},
              {begin: '%r{', end: '}[a-z]*'},
              {begin: '%r\\(', end: '\\)[a-z]*'},
              {begin: '%r!', end: '![a-z]*'},
              {begin: '%r\\[', end: '\\][a-z]*'}
            ]
          }
        ].concat(COMMENT_MODES),
        relevance: 0
      }
    ].concat(COMMENT_MODES);

    SUBST.contains = RUBY_DEFAULT_CONTAINS;
    PARAMS.contains = RUBY_DEFAULT_CONTAINS;

    var SIMPLE_PROMPT = "[>?]>";
    var DEFAULT_PROMPT = "[\\w#]+\\(\\w+\\):\\d+:\\d+>";
    var RVM_PROMPT = "(\\w+-)?\\d+\\.\\d+\\.\\d(p\\d+)?[^>]+>";

    var IRB_DEFAULT = [
      {
        begin: /^\s*=>/,
        starts: {
          end: '$', contains: RUBY_DEFAULT_CONTAINS
        }
      },
      {
        className: 'meta',
        begin: '^('+SIMPLE_PROMPT+"|"+DEFAULT_PROMPT+'|'+RVM_PROMPT+')',
        starts: {
          end: '$', contains: RUBY_DEFAULT_CONTAINS
        }
      }
    ];

    return {
      name: 'Ruby',
      aliases: ['rb', 'gemspec', 'podspec', 'thor', 'irb'],
      keywords: RUBY_KEYWORDS,
      illegal: /\/\*/,
      contains: COMMENT_MODES.concat(IRB_DEFAULT).concat(RUBY_DEFAULT_CONTAINS)
    };
  }

  return ruby;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('rust', function () {
  'use strict';

  /*
  Language: Rust
  Author: Andrey Vlasovskikh <andrey.vlasovskikh@gmail.com>
  Contributors: Roman Shmatov <romanshmatov@gmail.com>, Kasper Andersen <kma_untrusted@protonmail.com>
  Website: https://www.rust-lang.org
  Category: common, system
  */

  function rust(hljs) {
    var NUM_SUFFIX = '([ui](8|16|32|64|128|size)|f(32|64))\?';
    var KEYWORDS =
      'abstract as async await become box break const continue crate do dyn ' +
      'else enum extern false final fn for if impl in let loop macro match mod ' +
      'move mut override priv pub ref return self Self static struct super ' +
      'trait true try type typeof unsafe unsized use virtual where while yield';
    var BUILTINS =
      // functions
      'drop ' +
      // types
      'i8 i16 i32 i64 i128 isize ' +
      'u8 u16 u32 u64 u128 usize ' +
      'f32 f64 ' +
      'str char bool ' +
      'Box Option Result String Vec ' +
      // traits
      'Copy Send Sized Sync Drop Fn FnMut FnOnce ToOwned Clone Debug ' +
      'PartialEq PartialOrd Eq Ord AsRef AsMut Into From Default Iterator ' +
      'Extend IntoIterator DoubleEndedIterator ExactSizeIterator ' +
      'SliceConcatExt ToString ' +
      // macros
      'assert! assert_eq! bitflags! bytes! cfg! col! concat! concat_idents! ' +
      'debug_assert! debug_assert_eq! env! panic! file! format! format_args! ' +
      'include_bin! include_str! line! local_data_key! module_path! ' +
      'option_env! print! println! select! stringify! try! unimplemented! ' +
      'unreachable! vec! write! writeln! macro_rules! assert_ne! debug_assert_ne!';
    return {
      name: 'Rust',
      aliases: ['rs'],
      keywords: {
        $pattern: hljs.IDENT_RE + '!?',
        keyword:
          KEYWORDS,
        literal:
          'true false Some None Ok Err',
        built_in:
          BUILTINS
      },
      illegal: '</',
      contains: [
        hljs.C_LINE_COMMENT_MODE,
        hljs.COMMENT('/\\*', '\\*/', {contains: ['self']}),
        hljs.inherit(hljs.QUOTE_STRING_MODE, {begin: /b?"/, illegal: null}),
        {
          className: 'string',
          variants: [
             { begin: /r(#*)"(.|\n)*?"\1(?!#)/ },
             { begin: /b?'\\?(x\w{2}|u\w{4}|U\w{8}|.)'/ }
          ]
        },
        {
          className: 'symbol',
          begin: /'[a-zA-Z_][a-zA-Z0-9_]*/
        },
        {
          className: 'number',
          variants: [
            { begin: '\\b0b([01_]+)' + NUM_SUFFIX },
            { begin: '\\b0o([0-7_]+)' + NUM_SUFFIX },
            { begin: '\\b0x([A-Fa-f0-9_]+)' + NUM_SUFFIX },
            { begin: '\\b(\\d[\\d_]*(\\.[0-9_]+)?([eE][+-]?[0-9_]+)?)' +
                     NUM_SUFFIX
            }
          ],
          relevance: 0
        },
        {
          className: 'function',
          beginKeywords: 'fn', end: '(\\(|<)', excludeEnd: true,
          contains: [hljs.UNDERSCORE_TITLE_MODE]
        },
        {
          className: 'meta',
          begin: '#\\!?\\[', end: '\\]',
          contains: [
            {
              className: 'meta-string',
              begin: /"/, end: /"/
            }
          ]
        },
        {
          className: 'class',
          beginKeywords: 'type', end: ';',
          contains: [
            hljs.inherit(hljs.UNDERSCORE_TITLE_MODE, {endsParent: true})
          ],
          illegal: '\\S'
        },
        {
          className: 'class',
          beginKeywords: 'trait enum struct union', end: '{',
          contains: [
            hljs.inherit(hljs.UNDERSCORE_TITLE_MODE, {endsParent: true})
          ],
          illegal: '[\\w\\d]'
        },
        {
          begin: hljs.IDENT_RE + '::',
          keywords: {built_in: BUILTINS}
        },
        {
          begin: '->'
        }
      ]
    };
  }

  return rust;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('scss', function () {
  'use strict';

  /*
  Language: SCSS
  Description: Scss is an extension of the syntax of CSS.
  Author: Kurt Emch <kurt@kurtemch.com>
  Website: https://sass-lang.com
  Category: common, css
  */
  function scss(hljs) {
    var AT_IDENTIFIER = '@[a-z-]+'; // @font-face
    var AT_MODIFIERS = "and or not only";
    var IDENT_RE = '[a-zA-Z-][a-zA-Z0-9_-]*';
    var VARIABLE = {
      className: 'variable',
      begin: '(\\$' + IDENT_RE + ')\\b'
    };
    var HEXCOLOR = {
      className: 'number', begin: '#[0-9A-Fa-f]+'
    };
    var DEF_INTERNALS = {
      className: 'attribute',
      begin: '[A-Z\\_\\.\\-]+', end: ':',
      excludeEnd: true,
      illegal: '[^\\s]',
      starts: {
        endsWithParent: true, excludeEnd: true,
        contains: [
          HEXCOLOR,
          hljs.CSS_NUMBER_MODE,
          hljs.QUOTE_STRING_MODE,
          hljs.APOS_STRING_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          {
            className: 'meta', begin: '!important'
          }
        ]
      }
    };
    return {
      name: 'SCSS',
      case_insensitive: true,
      illegal: '[=/|\']',
      contains: [
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        {
          className: 'selector-id', begin: '\\#[A-Za-z0-9_-]+',
          relevance: 0
        },
        {
          className: 'selector-class', begin: '\\.[A-Za-z0-9_-]+',
          relevance: 0
        },
        {
          className: 'selector-attr', begin: '\\[', end: '\\]',
          illegal: '$'
        },
        {
          className: 'selector-tag', // begin: IDENT_RE, end: '[,|\\s]'
          begin: '\\b(a|abbr|acronym|address|area|article|aside|audio|b|base|big|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|command|datalist|dd|del|details|dfn|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|frame|frameset|(h[1-6])|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|keygen|label|legend|li|link|map|mark|meta|meter|nav|noframes|noscript|object|ol|optgroup|option|output|p|param|pre|progress|q|rp|rt|ruby|samp|script|section|select|small|span|strike|strong|style|sub|sup|table|tbody|td|textarea|tfoot|th|thead|time|title|tr|tt|ul|var|video)\\b',
          relevance: 0
        },
        {
          className: 'selector-pseudo',
          begin: ':(visited|valid|root|right|required|read-write|read-only|out-range|optional|only-of-type|only-child|nth-of-type|nth-last-of-type|nth-last-child|nth-child|not|link|left|last-of-type|last-child|lang|invalid|indeterminate|in-range|hover|focus|first-of-type|first-line|first-letter|first-child|first|enabled|empty|disabled|default|checked|before|after|active)'
        },
        {
          className: 'selector-pseudo',
          begin: '::(after|before|choices|first-letter|first-line|repeat-index|repeat-item|selection|value)'
        },
        VARIABLE,
        {
          className: 'attribute',
          begin: '\\b(src|z-index|word-wrap|word-spacing|word-break|width|widows|white-space|visibility|vertical-align|unicode-bidi|transition-timing-function|transition-property|transition-duration|transition-delay|transition|transform-style|transform-origin|transform|top|text-underline-position|text-transform|text-shadow|text-rendering|text-overflow|text-indent|text-decoration-style|text-decoration-line|text-decoration-color|text-decoration|text-align-last|text-align|tab-size|table-layout|right|resize|quotes|position|pointer-events|perspective-origin|perspective|page-break-inside|page-break-before|page-break-after|padding-top|padding-right|padding-left|padding-bottom|padding|overflow-y|overflow-x|overflow-wrap|overflow|outline-width|outline-style|outline-offset|outline-color|outline|orphans|order|opacity|object-position|object-fit|normal|none|nav-up|nav-right|nav-left|nav-index|nav-down|min-width|min-height|max-width|max-height|mask|marks|margin-top|margin-right|margin-left|margin-bottom|margin|list-style-type|list-style-position|list-style-image|list-style|line-height|letter-spacing|left|justify-content|initial|inherit|ime-mode|image-orientation|image-resolution|image-rendering|icon|hyphens|height|font-weight|font-variant-ligatures|font-variant|font-style|font-stretch|font-size-adjust|font-size|font-language-override|font-kerning|font-feature-settings|font-family|font|float|flex-wrap|flex-shrink|flex-grow|flex-flow|flex-direction|flex-basis|flex|filter|empty-cells|display|direction|cursor|counter-reset|counter-increment|content|column-width|column-span|column-rule-width|column-rule-style|column-rule-color|column-rule|column-gap|column-fill|column-count|columns|color|clip-path|clip|clear|caption-side|break-inside|break-before|break-after|box-sizing|box-shadow|box-decoration-break|bottom|border-width|border-top-width|border-top-style|border-top-right-radius|border-top-left-radius|border-top-color|border-top|border-style|border-spacing|border-right-width|border-right-style|border-right-color|border-right|border-radius|border-left-width|border-left-style|border-left-color|border-left|border-image-width|border-image-source|border-image-slice|border-image-repeat|border-image-outset|border-image|border-color|border-collapse|border-bottom-width|border-bottom-style|border-bottom-right-radius|border-bottom-left-radius|border-bottom-color|border-bottom|border|background-size|background-repeat|background-position|background-origin|background-image|background-color|background-clip|background-attachment|background-blend-mode|background|backface-visibility|auto|animation-timing-function|animation-play-state|animation-name|animation-iteration-count|animation-fill-mode|animation-duration|animation-direction|animation-delay|animation|align-self|align-items|align-content)\\b',
          illegal: '[^\\s]'
        },
        {
          begin: '\\b(whitespace|wait|w-resize|visible|vertical-text|vertical-ideographic|uppercase|upper-roman|upper-alpha|underline|transparent|top|thin|thick|text|text-top|text-bottom|tb-rl|table-header-group|table-footer-group|sw-resize|super|strict|static|square|solid|small-caps|separate|se-resize|scroll|s-resize|rtl|row-resize|ridge|right|repeat|repeat-y|repeat-x|relative|progress|pointer|overline|outside|outset|oblique|nowrap|not-allowed|normal|none|nw-resize|no-repeat|no-drop|newspaper|ne-resize|n-resize|move|middle|medium|ltr|lr-tb|lowercase|lower-roman|lower-alpha|loose|list-item|line|line-through|line-edge|lighter|left|keep-all|justify|italic|inter-word|inter-ideograph|inside|inset|inline|inline-block|inherit|inactive|ideograph-space|ideograph-parenthesis|ideograph-numeric|ideograph-alpha|horizontal|hidden|help|hand|groove|fixed|ellipsis|e-resize|double|dotted|distribute|distribute-space|distribute-letter|distribute-all-lines|disc|disabled|default|decimal|dashed|crosshair|collapse|col-resize|circle|char|center|capitalize|break-word|break-all|bottom|both|bolder|bold|block|bidi-override|below|baseline|auto|always|all-scroll|absolute|table|table-cell)\\b'
        },
        {
          begin: ':', end: ';',
          contains: [
            VARIABLE,
            HEXCOLOR,
            hljs.CSS_NUMBER_MODE,
            hljs.QUOTE_STRING_MODE,
            hljs.APOS_STRING_MODE,
            {
              className: 'meta', begin: '!important'
            }
          ]
        },
        // matching these here allows us to treat them more like regular CSS
        // rules so everything between the {} gets regular rule highlighting,
        // which is what we want for page and font-face
        {
          begin: '@(page|font-face)',
          lexemes: AT_IDENTIFIER,
          keywords: '@page @font-face'
        },
        {
          begin: '@', end: '[{;]',
          returnBegin: true,
          keywords: AT_MODIFIERS,
          contains: [
            {
              begin: AT_IDENTIFIER,
              className: "keyword"
            },
            VARIABLE,
            hljs.QUOTE_STRING_MODE,
            hljs.APOS_STRING_MODE,
            HEXCOLOR,
            hljs.CSS_NUMBER_MODE,
            // {
            //   begin: '\\s[A-Za-z0-9_.-]+',
            //   relevance: 0
            // }
          ]
        }
      ]
    };
  }

  return scss;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('swift', function () {
  'use strict';

  /*
  Language: Swift
  Description: Swift is a general-purpose programming language built using a modern approach to safety, performance, and software design patterns.
  Author: Chris Eidhof <chris@eidhof.nl>
  Contributors: Nate Cook <natecook@gmail.com>, Alexander Lichter <manniL@gmx.net>
  Website: https://swift.org
  Category: common, system
  */


  function swift(hljs) {
    var SWIFT_KEYWORDS = {
        keyword: '#available #colorLiteral #column #else #elseif #endif #file ' +
          '#fileLiteral #function #if #imageLiteral #line #selector #sourceLocation ' +
          '_ __COLUMN__ __FILE__ __FUNCTION__ __LINE__ Any as as! as? associatedtype ' +
          'associativity break case catch class continue convenience default defer deinit didSet do ' +
          'dynamic dynamicType else enum extension fallthrough false fileprivate final for func ' +
          'get guard if import in indirect infix init inout internal is lazy left let ' +
          'mutating nil none nonmutating open operator optional override postfix precedence ' +
          'prefix private protocol Protocol public repeat required rethrows return ' +
          'right self Self set static struct subscript super switch throw throws true ' +
          'try try! try? Type typealias unowned var weak where while willSet',
        literal: 'true false nil',
        built_in: 'abs advance alignof alignofValue anyGenerator assert assertionFailure ' +
          'bridgeFromObjectiveC bridgeFromObjectiveCUnconditional bridgeToObjectiveC ' +
          'bridgeToObjectiveCUnconditional c compactMap contains count countElements countLeadingZeros ' +
          'debugPrint debugPrintln distance dropFirst dropLast dump encodeBitsAsWords ' +
          'enumerate equal fatalError filter find getBridgedObjectiveCType getVaList ' +
          'indices insertionSort isBridgedToObjectiveC isBridgedVerbatimToObjectiveC ' +
          'isUniquelyReferenced isUniquelyReferencedNonObjC join lazy lexicographicalCompare ' +
          'map max maxElement min minElement numericCast overlaps partition posix ' +
          'precondition preconditionFailure print println quickSort readLine reduce reflect ' +
          'reinterpretCast reverse roundUpToAlignment sizeof sizeofValue sort split ' +
          'startsWith stride strideof strideofValue swap toString transcode ' +
          'underestimateCount unsafeAddressOf unsafeBitCast unsafeDowncast unsafeUnwrap ' +
          'unsafeReflect withExtendedLifetime withObjectAtPlusZero withUnsafePointer ' +
          'withUnsafePointerToObject withUnsafeMutablePointer withUnsafeMutablePointers ' +
          'withUnsafePointer withUnsafePointers withVaList zip'
      };

    var TYPE = {
      className: 'type',
      begin: '\\b[A-Z][\\w\u00C0-\u02B8\']*',
      relevance: 0
    };
    // slightly more special to swift
    var OPTIONAL_USING_TYPE = {
      className: 'type',
      begin: '\\b[A-Z][\\w\u00C0-\u02B8\']*[!?]'
    };
    var BLOCK_COMMENT = hljs.COMMENT(
      '/\\*',
      '\\*/',
      {
        contains: ['self']
      }
    );
    var SUBST = {
      className: 'subst',
      begin: /\\\(/, end: '\\)',
      keywords: SWIFT_KEYWORDS,
      contains: [] // assigned later
    };
    var STRING = {
      className: 'string',
      contains: [hljs.BACKSLASH_ESCAPE, SUBST],
      variants: [
        {begin: /"""/, end: /"""/},
        {begin: /"/, end: /"/},
      ]
    };
    var NUMBERS = {
        className: 'number',
        begin: '\\b([\\d_]+(\\.[\\deE_]+)?|0x[a-fA-F0-9_]+(\\.[a-fA-F0-9p_]+)?|0b[01_]+|0o[0-7_]+)\\b',
        relevance: 0
    };
    SUBST.contains = [NUMBERS];

    return {
      name: 'Swift',
      keywords: SWIFT_KEYWORDS,
      contains: [
        STRING,
        hljs.C_LINE_COMMENT_MODE,
        BLOCK_COMMENT,
        OPTIONAL_USING_TYPE,
        TYPE,
        NUMBERS,
        {
          className: 'function',
          beginKeywords: 'func', end: '{', excludeEnd: true,
          contains: [
            hljs.inherit(hljs.TITLE_MODE, {
              begin: /[A-Za-z$_][0-9A-Za-z$_]*/
            }),
            {
              begin: /</, end: />/
            },
            {
              className: 'params',
              begin: /\(/, end: /\)/, endsParent: true,
              keywords: SWIFT_KEYWORDS,
              contains: [
                'self',
                NUMBERS,
                STRING,
                hljs.C_BLOCK_COMMENT_MODE,
                {begin: ':'} // relevance booster
              ],
              illegal: /["']/
            }
          ],
          illegal: /\[|%/
        },
        {
          className: 'class',
          beginKeywords: 'struct protocol class extension enum',
          keywords: SWIFT_KEYWORDS,
          end: '\\{',
          excludeEnd: true,
          contains: [
            hljs.inherit(hljs.TITLE_MODE, {begin: /[A-Za-z$_][\u00C0-\u02B80-9A-Za-z$_]*/})
          ]
        },
        {
          className: 'meta', // @attributes
          begin: '(@discardableResult|@warn_unused_result|@exported|@lazy|@noescape|' +
                    '@NSCopying|@NSManaged|@objc|@objcMembers|@convention|@required|' +
                    '@noreturn|@IBAction|@IBDesignable|@IBInspectable|@IBOutlet|' +
                    '@infix|@prefix|@postfix|@autoclosure|@testable|@available|' +
                    '@nonobjc|@NSApplicationMain|@UIApplicationMain|@dynamicMemberLookup|' +
                    '@propertyWrapper)\\b'

        },
        {
          beginKeywords: 'import', end: /$/,
          contains: [hljs.C_LINE_COMMENT_MODE, BLOCK_COMMENT]
        }
      ]
    };
  }

  return swift;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('typescript', function () {
  'use strict';

  const IDENT_RE = '[A-Za-z$_][0-9A-Za-z$_]*';
  const KEYWORDS = [
    "as", // for exports
    "in",
    "of",
    "if",
    "for",
    "while",
    "finally",
    "var",
    "new",
    "function",
    "do",
    "return",
    "void",
    "else",
    "break",
    "catch",
    "instanceof",
    "with",
    "throw",
    "case",
    "default",
    "try",
    "switch",
    "continue",
    "typeof",
    "delete",
    "let",
    "yield",
    "const",
    "class",
    // JS handles these with a special rule
    // "get",
    // "set",
    "debugger",
    "async",
    "await",
    "static",
    "import",
    "from",
    "export",
    "extends"
  ];
  const LITERALS = [
    "true",
    "false",
    "null",
    "undefined",
    "NaN",
    "Infinity"
  ];

  const TYPES = [
    "Intl",
    "DataView",
    "Number",
    "Math",
    "Date",
    "String",
    "RegExp",
    "Object",
    "Function",
    "Boolean",
    "Error",
    "Symbol",
    "Set",
    "Map",
    "WeakSet",
    "WeakMap",
    "Proxy",
    "Reflect",
    "JSON",
    "Promise",
    "Float64Array",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "Uint16Array",
    "Uint32Array",
    "Float32Array",
    "Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "ArrayBuffer"
  ];

  const ERROR_TYPES = [
    "EvalError",
    "InternalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError"
  ];

  const BUILT_IN_GLOBALS = [
    "setInterval",
    "setTimeout",
    "clearInterval",
    "clearTimeout",

    "require",
    "exports",

    "eval",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "unescape"
  ];

  const BUILT_IN_VARIABLES = [
    "arguments",
    "this",
    "super",
    "console",
    "window",
    "document",
    "localStorage",
    "module",
    "global" // Node.js
  ];

  const BUILT_INS = [].concat(
    BUILT_IN_GLOBALS,
    BUILT_IN_VARIABLES,
    TYPES,
    ERROR_TYPES
  );

  /**
   * @param {string} value
   * @returns {RegExp}
   * */

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function source(re) {
    if (!re) return null;
    if (typeof re === "string") return re;

    return re.source;
  }

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function lookahead(re) {
    return concat('(?=', re, ')');
  }

  /**
   * @param {RegExp | string } re
   * @returns {string}
   */
  function optional(re) {
    return concat('(', re, ')?');
  }

  /**
   * @param {...(RegExp | string) } args
   * @returns {string}
   */
  function concat(...args) {
    const joined = args.map((x) => source(x)).join("");
    return joined;
  }

  /*
  Language: JavaScript
  Description: JavaScript (JS) is a lightweight, interpreted, or just-in-time compiled programming language with first-class functions.
  Category: common, scripting
  Website: https://developer.mozilla.org/en-US/docs/Web/JavaScript
  */

  /** @type LanguageFn */
  function javascript(hljs) {
    /**
     * Takes a string like "<Booger" and checks to see
     * if we can find a matching "</Booger" later in the
     * content.
     * @param {RegExpMatchArray} match
     * @param {{after:number}} param1
     */
    const hasClosingTag = (match, { after }) => {
      const tag = match[0].replace("<", "</");
      const pos = match.input.indexOf(tag, after);
      return pos !== -1;
    };

    const IDENT_RE$1 = IDENT_RE;
    const FRAGMENT = {
      begin: '<>',
      end: '</>'
    };
    const XML_TAG = {
      begin: /<[A-Za-z0-9\\._:-]+/,
      end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
      /**
       * @param {RegExpMatchArray} match
       * @param {CallbackResponse} response
       */
      isTrulyOpeningTag: (match, response) => {
        const afterMatchIndex = match[0].length + match.index;
        const nextChar = match.input[afterMatchIndex];
        // nested type?
        // HTML should not include another raw `<` inside a tag
        // But a type might: `<Array<Array<number>>`, etc.
        if (nextChar === "<") {
          response.ignoreMatch();
          return;
        }
        // <something>
        // This is now either a tag or a type.
        if (nextChar === ">") {
          // if we cannot find a matching closing tag, then we
          // will ignore it
          if (!hasClosingTag(match, { after: afterMatchIndex })) {
            response.ignoreMatch();
          }
        }
      }
    };
    const KEYWORDS$1 = {
      $pattern: IDENT_RE,
      keyword: KEYWORDS.join(" "),
      literal: LITERALS.join(" "),
      built_in: BUILT_INS.join(" ")
    };
    const nonDecimalLiterals = (prefixLetters, validChars) =>
      `\\b0[${prefixLetters}][${validChars}]([${validChars}_]*[${validChars}])?n?`;
    const noLeadingZeroDecimalDigits = /[1-9]([0-9_]*\d)?/;
    const decimalDigits = /\d([0-9_]*\d)?/;
    const exponentPart = concat(/[eE][+-]?/, decimalDigits);
    const NUMBER = {
      className: 'number',
      variants: [
        { begin: nonDecimalLiterals('bB', '01') }, // Binary literals
        { begin: nonDecimalLiterals('oO', '0-7') }, // Octal literals
        { begin: nonDecimalLiterals('xX', '0-9a-fA-F') }, // Hexadecimal literals
        { begin: concat(/\b/, noLeadingZeroDecimalDigits, 'n') }, // Non-zero BigInt literals
        { begin: concat(/(\b0)?\./, decimalDigits, optional(exponentPart)) }, // Decimal literals between 0 and 1
        { begin: concat(
          /\b/,
          noLeadingZeroDecimalDigits,
          optional(concat(/\./, optional(decimalDigits))), // fractional part
          optional(exponentPart)
          ) }, // Decimal literals >= 1
        { begin: /\b0[\.n]?/ }, // Zero literals (`0`, `0.`, `0n`)
      ],
      relevance: 0
    };
    const SUBST = {
      className: 'subst',
      begin: '\\$\\{',
      end: '\\}',
      keywords: KEYWORDS$1,
      contains: [] // defined later
    };
    const HTML_TEMPLATE = {
      begin: 'html`',
      end: '',
      starts: {
        end: '`',
        returnEnd: false,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          SUBST
        ],
        subLanguage: 'xml'
      }
    };
    const CSS_TEMPLATE = {
      begin: 'css`',
      end: '',
      starts: {
        end: '`',
        returnEnd: false,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          SUBST
        ],
        subLanguage: 'css'
      }
    };
    const TEMPLATE_STRING = {
      className: 'string',
      begin: '`',
      end: '`',
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ]
    };
    const JSDOC_COMMENT = hljs.COMMENT(
      '/\\*\\*',
      '\\*/',
      {
        relevance: 0,
        contains: [
          {
            className: 'doctag',
            begin: '@[A-Za-z]+',
            contains: [
              {
                className: 'type',
                begin: '\\{',
                end: '\\}',
                relevance: 0
              },
              {
                className: 'variable',
                begin: IDENT_RE$1 + '(?=\\s*(-)|$)',
                endsParent: true,
                relevance: 0
              },
              // eat spaces (not newlines) so we can find
              // types or variables
              {
                begin: /(?=[^\n])\s/,
                relevance: 0
              }
            ]
          }
        ]
      }
    );
    const COMMENT = {
      className: "comment",
      variants: [
        JSDOC_COMMENT,
        hljs.C_BLOCK_COMMENT_MODE,
        hljs.C_LINE_COMMENT_MODE
      ]
    };
    const SUBST_INTERNALS = [
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      HTML_TEMPLATE,
      CSS_TEMPLATE,
      TEMPLATE_STRING,
      NUMBER,
      hljs.REGEXP_MODE
    ];
    SUBST.contains = SUBST_INTERNALS
      .concat({
        // we need to pair up {} inside our subst to prevent
        // it from ending too early by matching another }
        begin: /{/,
        end: /}/,
        keywords: KEYWORDS$1,
        contains: [
          "self"
        ].concat(SUBST_INTERNALS)
      });
    const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
    const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
      // eat recursive parens in sub expressions
      {
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS$1,
        contains: ["self"].concat(SUBST_AND_COMMENTS)
      }
    ]);
    const PARAMS = {
      className: 'params',
      begin: /\(/,
      end: /\)/,
      excludeBegin: true,
      excludeEnd: true,
      keywords: KEYWORDS$1,
      contains: PARAMS_CONTAINS
    };

    return {
      name: 'Javascript',
      aliases: ['js', 'jsx', 'mjs', 'cjs'],
      keywords: KEYWORDS$1,
      // this will be extended by TypeScript
      exports: { PARAMS_CONTAINS },
      illegal: /#(?![$_A-z])/,
      contains: [
        hljs.SHEBANG({
          label: "shebang",
          binary: "node",
          relevance: 5
        }),
        {
          label: "use_strict",
          className: 'meta',
          relevance: 10,
          begin: /^\s*['"]use (strict|asm)['"]/
        },
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE,
        HTML_TEMPLATE,
        CSS_TEMPLATE,
        TEMPLATE_STRING,
        COMMENT,
        NUMBER,
        { // object attr container
          begin: concat(/[{,\n]\s*/,
            // we need to look ahead to make sure that we actually have an
            // attribute coming up so we don't steal a comma from a potential
            // "value" container
            //
            // NOTE: this might not work how you think.  We don't actually always
            // enter this mode and stay.  Instead it might merely match `,
            // <comments up next>` and then immediately end after the , because it
            // fails to find any actual attrs. But this still does the job because
            // it prevents the value contain rule from grabbing this instead and
            // prevening this rule from firing when we actually DO have keys.
            lookahead(concat(
              // we also need to allow for multiple possible comments inbetween
              // the first key:value pairing
              /(\/\/.*$)*/,
              /(\/\*(.|\n)*\*\/)*/,
              /\s*/,
              IDENT_RE$1 + '\\s*:'))),
          relevance: 0,
          contains: [
            {
              className: 'attr',
              begin: IDENT_RE$1 + lookahead('\\s*:'),
              relevance: 0
            }
          ]
        },
        { // "value" container
          begin: '(' + hljs.RE_STARTERS_RE + '|\\b(case|return|throw)\\b)\\s*',
          keywords: 'return throw case',
          contains: [
            COMMENT,
            hljs.REGEXP_MODE,
            {
              className: 'function',
              // we have to count the parens to make sure we actually have the
              // correct bounding ( ) before the =>.  There could be any number of
              // sub-expressions inside also surrounded by parens.
              begin: '(\\(' +
              '[^()]*(\\(' +
              '[^()]*(\\(' +
              '[^()]*' +
              '\\))*[^()]*' +
              '\\))*[^()]*' +
              '\\)|' + hljs.UNDERSCORE_IDENT_RE + ')\\s*=>',
              returnBegin: true,
              end: '\\s*=>',
              contains: [
                {
                  className: 'params',
                  variants: [
                    {
                      begin: hljs.UNDERSCORE_IDENT_RE
                    },
                    {
                      className: null,
                      begin: /\(\s*\)/,
                      skip: true
                    },
                    {
                      begin: /\(/,
                      end: /\)/,
                      excludeBegin: true,
                      excludeEnd: true,
                      keywords: KEYWORDS$1,
                      contains: PARAMS_CONTAINS
                    }
                  ]
                }
              ]
            },
            { // could be a comma delimited list of params to a function call
              begin: /,/, relevance: 0
            },
            {
              className: '',
              begin: /\s/,
              end: /\s*/,
              skip: true
            },
            { // JSX
              variants: [
                { begin: FRAGMENT.begin, end: FRAGMENT.end },
                {
                  begin: XML_TAG.begin,
                  // we carefully check the opening tag to see if it truly
                  // is a tag and not a false positive
                  'on:begin': XML_TAG.isTrulyOpeningTag,
                  end: XML_TAG.end
                }
              ],
              subLanguage: 'xml',
              contains: [
                {
                  begin: XML_TAG.begin,
                  end: XML_TAG.end,
                  skip: true,
                  contains: ['self']
                }
              ]
            }
          ],
          relevance: 0
        },
        {
          className: 'function',
          beginKeywords: 'function',
          end: /[{;]/,
          excludeEnd: true,
          keywords: KEYWORDS$1,
          contains: [
            'self',
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
            PARAMS
          ],
          illegal: /%/
        },
        {
          className: 'function',
          // we have to count the parens to make sure we actually have the correct
          // bounding ( ).  There could be any number of sub-expressions inside
          // also surrounded by parens.
          begin: hljs.UNDERSCORE_IDENT_RE +
            '\\(' + // first parens
            '[^()]*(\\(' +
              '[^()]*(\\(' +
                '[^()]*' +
              '\\))*[^()]*' +
            '\\))*[^()]*' +
            '\\)\\s*{', // end parens
          returnBegin:true,
          contains: [
            PARAMS,
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
          ]
        },
        // hack: prevents detection of keywords in some circumstances
        // .keyword()
        // $keyword = x
        {
          variants: [
            { begin: '\\.' + IDENT_RE$1 },
            { begin: '\\$' + IDENT_RE$1 }
          ],
          relevance: 0
        },
        { // ES6 class
          className: 'class',
          beginKeywords: 'class',
          end: /[{;=]/,
          excludeEnd: true,
          illegal: /[:"\[\]]/,
          contains: [
            { beginKeywords: 'extends' },
            hljs.UNDERSCORE_TITLE_MODE
          ]
        },
        {
          begin: /\b(?=constructor)/,
          end: /[\{;]/,
          excludeEnd: true,
          contains: [
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
            'self',
            PARAMS
          ]
        },
        {
          begin: '(get|set)\\s+(?=' + IDENT_RE$1 + '\\()',
          end: /{/,
          keywords: "get set",
          contains: [
            hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1 }),
            { begin: /\(\)/ }, // eat to avoid empty params
            PARAMS
          ]
        },
        {
          begin: /\$[(.]/ // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
        }
      ]
    };
  }

  /*
  Language: TypeScript
  Author: Panu Horsmalahti <panu.horsmalahti@iki.fi>
  Contributors: Ike Ku <dempfi@yahoo.com>
  Description: TypeScript is a strict superset of JavaScript
  Website: https://www.typescriptlang.org
  Category: common, scripting
  */

  /** @type LanguageFn */
  function typescript(hljs) {
    const IDENT_RE$1 = IDENT_RE;
    const NAMESPACE = {
      beginKeywords: 'namespace', end: /\{/, excludeEnd: true
    };
    const INTERFACE = {
      beginKeywords: 'interface', end: /\{/, excludeEnd: true,
      keywords: 'interface extends'
    };
    const USE_STRICT = {
      className: 'meta',
      relevance: 10,
      begin: /^\s*['"]use strict['"]/
    };
    const TYPES = [
      "any",
      "void",
      "number",
      "boolean",
      "string",
      "object",
      "never",
      "enum"
    ];
    const TS_SPECIFIC_KEYWORDS = [
      "type",
      "namespace",
      "typedef",
      "interface",
      "public",
      "private",
      "protected",
      "implements",
      "declare",
      "abstract",
      "readonly"
    ];
    const KEYWORDS$1 = {
      $pattern: IDENT_RE,
      keyword: KEYWORDS.concat(TS_SPECIFIC_KEYWORDS).join(" "),
      literal: LITERALS.join(" "),
      built_in: BUILT_INS.concat(TYPES).join(" ")
    };
    const DECORATOR = {
      className: 'meta',
      begin: '@' + IDENT_RE$1,
    };

    const swapMode = (mode, label, replacement) => {
      const indx = mode.contains.findIndex(m => m.label === label);
      if (indx === -1) { throw new Error("can not find mode to replace"); }
      mode.contains.splice(indx, 1, replacement);
    };

    const tsLanguage = javascript(hljs);

    // this should update anywhere keywords is used since
    // it will be the same actual JS object
    Object.assign(tsLanguage.keywords, KEYWORDS$1);

    tsLanguage.exports.PARAMS_CONTAINS.push(DECORATOR);
    tsLanguage.contains = tsLanguage.contains.concat([
      DECORATOR,
      NAMESPACE,
      INTERFACE,
    ]);

    // TS gets a simpler shebang rule than JS
    swapMode(tsLanguage, "shebang", hljs.SHEBANG());
    // JS use strict rule purposely excludes `asm` which makes no sense
    swapMode(tsLanguage, "use_strict", USE_STRICT);

    const functionDeclaration = tsLanguage.contains.find(m => m.className === "function");
    functionDeclaration.relevance = 0; // () => {} is more typical in TypeScript

    Object.assign(tsLanguage, {
      name: 'TypeScript',
      aliases: ['ts']
    });

    return tsLanguage;
  }

  return typescript;

  return module.exports.definer || module.exports;

}());

hljs.registerLanguage('yaml', function () {
  'use strict';

  /*
  Language: YAML
  Description: Yet Another Markdown Language
  Author: Stefan Wienert <stwienert@gmail.com>
  Contributors: Carl Baxter <carl@cbax.tech>
  Requires: ruby.js
  Website: https://yaml.org
  Category: common, config
  */
  function yaml(hljs) {
    var LITERALS = 'true false yes no null';

    // YAML spec allows non-reserved URI characters in tags.
    var URI_CHARACTERS = '[\\w#;/?:@&=+$,.~*\\\'()[\\]]+';

    // Define keys as starting with a word character
    // ...containing word chars, spaces, colons, forward-slashes, hyphens and periods
    // ...and ending with a colon followed immediately by a space, tab or newline.
    // The YAML spec allows for much more than this, but this covers most use-cases.
    var KEY = {
      className: 'attr',
      variants: [
        { begin: '\\w[\\w :\\/.-]*:(?=[ \t]|$)' },
        { begin: '"\\w[\\w :\\/.-]*":(?=[ \t]|$)' }, // double quoted keys
        { begin: '\'\\w[\\w :\\/.-]*\':(?=[ \t]|$)' } // single quoted keys
      ]
    };

    var TEMPLATE_VARIABLES = {
      className: 'template-variable',
      variants: [
        { begin: '{{', end: '}}' }, // jinja templates Ansible
        { begin: '%{', end: '}' } // Ruby i18n
      ]
    };
    var STRING = {
      className: 'string',
      relevance: 0,
      variants: [
        { begin: /'/, end: /'/ },
        { begin: /"/, end: /"/ },
        { begin: /\S+/ }
      ],
      contains: [
        hljs.BACKSLASH_ESCAPE,
        TEMPLATE_VARIABLES
      ]
    };

    // Strings inside of value containers (objects) can't contain braces,
    // brackets, or commas
    var CONTAINER_STRING = hljs.inherit(STRING, {
      variants: [
        { begin: /'/, end: /'/ },
        { begin: /"/, end: /"/ },
        { begin: /[^\s,{}[\]]+/ }
      ]
    });

    var DATE_RE = '[0-9]{4}(-[0-9][0-9]){0,2}';
    var TIME_RE = '([Tt \\t][0-9][0-9]?(:[0-9][0-9]){2})?';
    var FRACTION_RE = '(\\.[0-9]*)?';
    var ZONE_RE = '([ \\t])*(Z|[-+][0-9][0-9]?(:[0-9][0-9])?)?';
    var TIMESTAMP = {
      className: 'number',
      begin: '\\b' + DATE_RE + TIME_RE + FRACTION_RE + ZONE_RE + '\\b'
    };

    var VALUE_CONTAINER = {
      end: ',',
      endsWithParent: true,
      excludeEnd: true,
      contains: [],
      keywords: LITERALS,
      relevance: 0
    };
    var OBJECT = {
      begin: '{',
      end: '}',
      contains: [VALUE_CONTAINER],
      illegal: '\\n',
      relevance: 0
    };
    var ARRAY = {
      begin: '\\[',
      end: '\\]',
      contains: [VALUE_CONTAINER],
      illegal: '\\n',
      relevance: 0
    };

    var MODES = [
      KEY,
      {
        className: 'meta',
        begin: '^---\s*$',
        relevance: 10
      },
      { // multi line string
        // Blocks start with a | or > followed by a newline
        //
        // Indentation of subsequent lines must be the same to
        // be considered part of the block
        className: 'string',
        begin: '[\\|>]([0-9]?[+-])?[ ]*\\n( *)[\\S ]+\\n(\\2[\\S ]+\\n?)*'
      },
      { // Ruby/Rails erb
        begin: '<%[%=-]?',
        end: '[%-]?%>',
        subLanguage: 'ruby',
        excludeBegin: true,
        excludeEnd: true,
        relevance: 0
      },
      { // named tags
        className: 'type',
        begin: '!\\w+!' + URI_CHARACTERS
      },
      // https://yaml.org/spec/1.2/spec.html#id2784064
      { // verbatim tags
        className: 'type',
        begin: '!<' + URI_CHARACTERS + ">"
      },
      { // primary tags
        className: 'type',
        begin: '!' + URI_CHARACTERS
      },
      { // secondary tags
        className: 'type',
        begin: '!!' + URI_CHARACTERS
      },
      { // fragment id &ref
        className: 'meta',
        begin: '&' + hljs.UNDERSCORE_IDENT_RE + '$'
      },
      { // fragment reference *ref
        className: 'meta',
        begin: '\\*' + hljs.UNDERSCORE_IDENT_RE + '$'
      },
      { // array listing
        className: 'bullet',
        // TODO: remove |$ hack when we have proper look-ahead support
        begin: '\\-(?=[ ]|$)',
        relevance: 0
      },
      hljs.HASH_COMMENT_MODE,
      {
        beginKeywords: LITERALS,
        keywords: { literal: LITERALS }
      },
      TIMESTAMP,
      // numbers are any valid C-style number that
      // sit isolated from other words
      {
        className: 'number',
        begin: hljs.C_NUMBER_RE + '\\b'
      },
      OBJECT,
      ARRAY,
      STRING
    ];

    var VALUE_MODES = [...MODES];
    VALUE_MODES.pop();
    VALUE_MODES.push(CONTAINER_STRING);
    VALUE_CONTAINER.contains = VALUE_MODES;

    return {
      name: 'YAML',
      case_insensitive: true,
      aliases: ['yml', 'YAML'],
      contains: MODES
    };
  }

  return yaml;

  return module.exports.definer || module.exports;

}());
