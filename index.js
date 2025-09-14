  (function (global) {
    'use strict';

    // ---------------- Utils ----------------
    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, function (ch) {
        switch (ch) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          case "'": return '&#39;';
        }
      });
    }

    // Simple char helpers
    function isWS(ch) { return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v'; }
    function isDec(ch) { return ch >= '0' && ch <= '9'; }
    function isHex(ch) { return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F') || (ch >= 'a' && ch <= 'f'); }
    function isOct(ch) { return ch >= '0' && ch <= '7'; }
    function isBin(ch) { return ch === '0' || ch === '1'; }

    // Identifier start/part via Unicode property escapes (modern browsers)
    var reIdStart = /[$_\p{ID_Start}]/u;
    var reIdContinue = /[$_\u200C\u200D\p{ID_Continue}]/u;

    function isIdStart(ch) { return reIdStart.test(ch); }
    function isIdContinue(ch) { return reIdContinue.test(ch); }

    // Keywords / reserved
    var KEYWORDS = new Set([
      'break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends',
      'finally','for','function','if','import','in','instanceof','new','return','super','switch','this','throw','try',
      'typeof','var','void','while','with','yield','let','enum','await','implements','interface','package','private',
      'protected','public','static'
    ]);
    var LITERALS = new Set(['true','false','null','undefined','NaN','Infinity']);

    // Context-sensitive: can a regex literal start here?
    function isRegexAllowed(prev) {
      if (!prev) return true;
      var t = prev.type, v = prev.value;
      if (t === 'keyword') {
        return ['return','case','throw','yield','await','typeof','delete','void','in','instanceof','new'].includes(v);
      }
      if (t === 'operator') {
        return true; // after operators we allow regex
      }
      if (t === 'punctuation') {
        return '([{,;:?'.indexOf(v) !== -1;
      }
      if (t === 'template_expr_start') {
        return true;
      }
      return false;
    }

    // ---------------- Tokenizer ----------------
    function tokenizeJS(input) {
      var i = 0, n = input.length, tokens = [];
      var stack = []; // for template literal nesting or block contexts

      function push(type, value) { tokens.push({ type: type, value: value }); }
      function peek(k) { return input[i + (k || 0)]; }
      function advance() { return input[i++]; }
      function from(start) { return input.slice(start, i); }
      function prevToken() { // find previous non-whitespace/comment token
        for (var j = tokens.length - 1; j >= 0; j--) {
          var tt = tokens[j].type;
          if (tt !== 'whitespace' && tt !== 'comment') return tokens[j];
        }
        return null;
      }

      function readWhitespace() {
        var s = i;
        while (i < n && isWS(input[i])) i++;
        push('whitespace', input.slice(s, i));
      }

      function readLineComment() {
        var s = i; i += 2;
        var isJsDoc = (input[i] === '*' && input[i+1] !== '/'); // not actually jsdoc; handled in block
        while (i < n && input[i] !== '\n') i++;
        push('comment', input.slice(s, i));
      }

      function readBlockComment() {
        var s = i; i += 2;
        var isJsDoc = input[s+2] === '*';
        while (i < n && !(input[i] === '*' && input[i+1] === '/')) i++;
        if (i < n) i += 2; else push('error', input.slice(s, i));
        var val = input.slice(s, i);
        if (isJsDoc) {
          // simple @tag highlighting inside
          var out = '';
          var k = 0;
          while (k < val.length) {
            if (val[k] === '@') {
              var st = k; k++;
              while (k < val.length && /[A-Za-z0-9_-]/.test(val[k])) k++;
              out += '<span class="tok-jsdoc-tag">' + escapeHtml(val.slice(st, k)) + '</span>';
            } else {
              out += escapeHtml(val[k]);
              k++;
            }
          }
          // Store as already-HTML; mark with special type
          tokens.push({ type: 'comment', value: val, _html: out });
        } else {
          push('comment', val);
        }
      }

      function readEscapeSequence() {
        var s = i;
        if (peek() === 'u') {
          i++;
          if (peek() === '{') {
            i++;
            var hexStart = i;
            while (i < n && isHex(peek())) i++;
            if (peek() === '}') i++;
          } else {
            for (var k=0;k<4 && isHex(peek());k++) i++;
          }
        } else if (peek() === 'x') {
          i++; for (var k2=0;k2<2 && isHex(peek());k2++) i++;
        } else {
          i++; // simple escape
        }
        return input.slice(s, i);
      }

      function readIdentifier(maybePrivate) {
        var s = i;
        if (maybePrivate && peek() === '#') { i++; // private
          if (peek() === '\\') readEscapeSequence();
          else if (isIdStart(peek())) i++;
          else { push('error', input.slice(s, i)); return; }
          while (i < n) {
            if (peek() === '\\') readEscapeSequence();
            else if (isIdContinue(peek())) i++;
            else break;
          }
          push('private', input.slice(s, i));
          return;
        }

        // start
        if (peek() === '\\') readEscapeSequence();
        else if (isIdStart(peek())) i++;
        else { push('error', from(s)); return; }

        // continue
        while (i < n) {
          if (peek() === '\\') readEscapeSequence();
          else if (isIdContinue(peek())) i++;
          else break;
        }

        var ident = input.slice(s, i);
        if (KEYWORDS.has(ident)) push('keyword', ident);
        else if (LITERALS.has(ident)) push('literal', ident);
        else push('identifier', ident);
      }

      function readNumber() {
        var s = i;
        var startCh = peek();
        var isFloat = false;
        if (startCh === '0' && (peek(1) === 'x' || peek(1) === 'X')) { i += 2; while (isHex(peek()) || peek()==='_') i++; }
        else if (startCh === '0' && (peek(1) === 'b' || peek(1) === 'B')) { i += 2; while (isBin(peek()) || peek()==='_') i++; }
        else if (startCh === '0' && (peek(1) === 'o' || peek(1) === 'O')) { i += 2; while (isOct(peek()) || peek()==='_') i++; }
        else {
          while (isDec(peek()) || peek()==='_') i++;
          if (peek() === '.') { isFloat = true; i++; while (isDec(peek()) || peek()==='_') i++; }
          if (peek() === 'e' || peek() === 'E') {
            isFloat = true; i++;
            if (peek() === '+' || peek() === '-') i++;
            while (isDec(peek()) || peek()==='_') i++;
          }
        }
        if (peek() === 'n') { i++; push('bigint', input.slice(s, i)); return; }
        push('number', input.slice(s, i));
      }

      function readString(quote) {
        var s = i; i++; // consume quote
        var closed = false;
        while (i < n) {
          var c = peek();
          if (c === '\\') { i += 2; continue; }
          if (c === quote) { i++; closed = true; break; }
          i++;
        }
        if (closed) push('string', input.slice(s, i));
        else push('error', input.slice(s, i));
      }

      function readTemplate() {
        var s = i; i++; // consume `
        var parts = [];
        var last = i;
        var closed = false;
        while (i < n) {
          var c = peek();
          if (c === '\\') { i += 2; continue; }
          if (c === '`') {
            // flush raw
            if (i > last) parts.push({ type:'template_raw', value: input.slice(last, i) });
            i++; closed = true; break;
          }
          if (c === '$' && peek(1) === '{') {
            // flush raw
            if (i > last) parts.push({ type:'template_raw', value: input.slice(last, i) });
            // ${ start
            i += 2;
            parts.push({ type:'template_expr_start', value:'${' });
            // tokenize inner expression until matching }
            var depth = 1;
            var innerStart = i;
            var innerTokens = [];
            var startIndexSnapshot = i;
            // Reuse the same tokenizer but constrained to depth
            while (i < n && depth > 0) {
              var ch = peek();

              // handle strings
              if (ch === '"' || ch === "'") { readString(ch); innerTokens.push(tokens.pop()); continue; }
              if (ch === '`') { readTemplate(); innerTokens.push(tokens.pop()); continue; }

              // comments
              if (ch === '/' && peek(1) === '/') { readLineComment(); innerTokens.push(tokens.pop()); continue; }
              if (ch === '/' && peek(1) === '*') { readBlockComment(); innerTokens.push(tokens.pop()); continue; }

              // braces
              if (ch === '{') { innerTokens.push({ type:'punctuation', value:'{' }); i++; depth++; continue; }
              if (ch === '}') { depth--; if (depth === 0) { i++; break; } innerTokens.push({ type:'punctuation', value:'}' }); i++; continue; }

              // regex vs divide
              if (ch === '/' && isRegexAllowed(innerTokens[innerTokens.length-1])) {
                var reg = readRegex();
                innerTokens.push(reg); continue;
              }

              // numbers
              if (isDec(ch) || (ch === '.' && isDec(peek(1)))) { readNumber(); innerTokens.push(tokens.pop()); continue; }

              // identifiers
              if (ch === '#' || ch === '\\' || isIdStart(ch)) { readIdentifier(ch === '#'); innerTokens.push(tokens.pop()); continue; }

              // operators/punct
              var three = input.substr(i,3), two = input.substr(i,2);
              if (OPS3.has(three)) { innerTokens.push({ type:'operator', value: three }); i+=3; continue; }
              if (OPS2.has(two)) { innerTokens.push({ type:'operator', value: two }); i+=2; continue; }
              if (OP1.test(ch)) { innerTokens.push({ type:'operator', value: ch }); i++; continue; }
              if (PUNC1.test(ch)) { innerTokens.push({ type:'punctuation', value: ch }); i++; continue; }

              // whitespace or unknown
              if (isWS(ch)) { var ws = i; while (i<n && isWS(peek())) i++; innerTokens.push({ type:'whitespace', value: input.slice(ws,i) }); continue; }
              innerTokens.push({ type:'error', value: advance() });
            }
            parts.push({ type:'template_expr', tokens: innerTokens });
            parts.push({ type:'template_expr_end', value:'}' });
            last = i;
            continue;
          }
          i++;
        }
        // build final token with embedded parts (renderer will handle)
        if (!closed) {
          push('error', input.slice(s, i));
        } else {
          push('template', { raw: input.slice(s, i), parts: parts, quote:'`' });
        }
      }

      function readRegex() {
        var s = i; i++; // consume /
        var closed = false;
        while (i < n) {
          var c = peek();
          if (c === '\\') { i += 2; continue; }
          if (c === '[') { // char class
            i++;
            while (i < n) {
              var cc = peek();
              if (cc === '\\') { i += 2; continue; }
              if (cc === ']') { i++; break; }
              i++;
            }
            continue;
          }
          if (c === '/') { i++; closed = true; break; }
          i++;
        }
        // flags
        var fStart = i;
        while (i < n && /[a-z]/i.test(peek())) i++;
        var body = input.slice(s, i);
        var tok = { type: closed ? 'regex' : 'error', value: body };
        return tok;
      }

      // Operators and punctuation sets
      var OPS3 = new Set(['===','!==','>>>','>>=','<<=','**=','&&=','||=','??=']);
      var OPS2 = new Set(['==','!=','<=','>=','&&','||','++','--','+=','-=','*=','/=','%=','**','<<','>>','=>','??','?.','&=','|=','^=','//','/*','%%','>>>' /* placeholder */]);
      var OP1 = /^[+\-*/%&|^~!?=<>:]$/;
      var PUNC1 = /^[()[\]{},.;]$/;

      // Main scan
      while (i < n) {
        var ch = peek();

        // whitespace
        if (isWS(ch)) { readWhitespace(); continue; }

        // comment
        if (ch === '/' && peek(1) === '/') { readLineComment(); continue; }
        if (ch === '/' && peek(1) === '*') { readBlockComment(); continue; }

        // string
        if (ch === '"' || ch === "'") { readString(ch); continue; }

        // template
        if (ch === '`') { readTemplate(); continue; }

        // regex vs divide
        if (ch === '/' && isRegexAllowed(prevToken())) {
          var regTok = readRegex();
          push(regTok.type, regTok.value);
          continue;
        }

        // number (including .123)
        if (isDec(ch) || (ch === '.' && isDec(peek(1)))) { readNumber(); continue; }

        // identifier or private
        if (ch === '#' || ch === '\\' || isIdStart(ch)) { readIdentifier(ch === '#'); continue; }

        // operators
        var three = input.substr(i,3), two = input.substr(i,2);
        if (OPS3.has(three)) { push('operator', three); i+=3; continue; }
        if (OPS2.has(two)) {
          // ensure // and /* handled earlier; here treat as operator
          if (two === '/*' || two === '//') { /* already matched above */ }
          push('operator', two); i+=2; continue;
        }
        if (OP1.test(ch)) { push('operator', ch); i++; continue; }

        // punctuation
        if (PUNC1.test(ch)) { push('punctuation', ch); i++; continue; }

        // fallback
        push('error', advance());
      }

      return tokens;
    }

    // ---------------- Renderer ----------------
    function toHtml(tokens) {
      var out = '';
      for (var k = 0; k < tokens.length; k++) {
        var t = tokens[k];

        // whitespace pass-through
        if (t.type === 'whitespace') { out += t.value; continue; }

        // block comment with inline jsdoc tags (pre-rendered)
        if (t.type === 'comment' && t._html) {
          out += '<span class="tok-comment">' + t._html + '</span>';
          continue;
        }

        // template rendering with recursive highlight for ${}
        if (t.type === 'template') {
          // render as a string-like token but with embedded parts
          var raw = t.value || t.raw || ''; // compatibility
          var parts = t.parts || t.value?.parts || [];
          out += '<span class="tok-template">`</span>';
          for (var p=0; p<parts.length; p++) {
            var part = parts[p];
            if (part.type === 'template_raw') {
              out += '<span class="tok-template">' + escapeHtml(part.value) + '</span>';
            } else if (part.type === 'template_expr_start') {
              out += '<span class="tok-punctuation">${</span>';
            } else if (part.type === 'template_expr') {
              out += toHtml(part.tokens);
            } else if (part.type === 'template_expr_end') {
              out += '<span class="tok-punctuation">}</span>';
            }
          }
          out += '<span class="tok-template">`</span>';
          continue;
        }

        var cls = 'tok-' + t.type;
        out += '<span class="' + cls + '">' + escapeHtml(t.value) + '</span>';
      }
      return out;
    }

    // ---------------- Public API ----------------
    var SyntaxHL = {
      tokenizeJS: tokenizeJS,
      highlightJS: function (code) { return toHtml(tokenizeJS(code)); },
      escapeHtml: escapeHtml
    };

    // expose global
    global.SyntaxHL = SyntaxHL;

  })(typeof window !== 'undefined' ? window : this);

  // --------------- Demo ---------------
  var demo =document.getElementById("out").textContent;
document.getElementById('out').innerHTML = SyntaxHL.highlightJS(demo);

  document.getElementById('out').innerHTML = SyntaxHL.highlightJS(demo);
