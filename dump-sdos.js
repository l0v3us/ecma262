'use strict';

let fs = require('fs');
let exec = require('child_process').execSync;

let jsdom = require('jsdom');

async function go() {
  let source = fs.readFileSync('./spec.html', 'utf8');

  let dom = new jsdom.JSDOM(source, { includeNodeLocations: true });

  let document = dom.window.document;

  let sdos = [];
  for (let grammar of document.querySelectorAll('emu-grammar')) {
    let type = grammar.getAttribute('type');
    if (type === 'example' || type === 'definition') {
      continue;
    }
    let alg = nextEle(grammar);
    if (alg && alg.nodeName === 'EMU-ALG') {

      let isInAnnexB = false;
      let isInText = false;
      let pointer = grammar;
      while (pointer) {
        if (pointer.id === 'sec-text-processing') {
          isInText = true;
          break;
        }
        if (pointer.id === 'sec-additional-ecmascript-features-for-web-browsers') {
          isInAnnexB = true;
        }
        pointer = pointer.parentElement;
      }
      sdos.push({ grammar, alg, isInText, isInAnnexB });
    }
  }

  // console.log([...new Set(sdos.filter(s => s.isInText).map(s => s.grammar.parentElement))].map(e => e.firstElementChild.innerHTML));
  // return;

  let clauses = [];
  let seenParents = new Set;
  for (let { alg, grammar, isInText, isInAnnexB } of sdos) {
    let parent = grammar.parentElement;
    if (seenParents.has(parent)) {
      continue;
    }
    seenParents.add(parent);

    if (isInText || isInAnnexB) {
      // these are special; skip them
      continue;
    }

    let pointer = parent.firstElementChild;
    if (pointer.nodeName !== 'H1') {
      throw new Error('expected H1, got ' + name(pointer));
    }
    if (pointer.innerHTML === 'Statement Rules' || pointer.innerHTML === 'Expression Rules') {
      // these are in `HasCallInTailPosition`, which is already grouped as it should be
      continue;
    }
    let nameMatch = pointer.innerHTML.match(/^(?:(?:Static|Runtime) Semantics: )(\w+)$/);
    if (nameMatch == null) {
      throw new Error('could not find name in ' + pointer.innerHTML);
    }
    let sdoName = nameMatch[1];
    if (sdoName === 'NumericValue') {
      // this has a bunch of prose
      continue;
    }

    if (sdoName === 'StringValue') {
      // this is weird in that it's basically three unrelated operations which share a name
      continue;
    }

    if (sdoName === 'Evaluation' || sdoName === 'Early Errors') {
      // we aren't planning to move these
      continue;
    }

    pointer = nextEle(pointer);
    pointer = skipHeader(pointer);
    if (name(pointer) !== 'emu-grammar') {
      throw new Error('unexpected node: ' + name(pointer));
    }

    while (true) {
      if (name(pointer) === 'emu-grammar') {
        let next = skipNotes(nextEle(pointer));
        if (name(next) === 'emu-alg') {
          pointer = skipNotes(nextEle(next));
          continue;
        }
      }
      break;
    }

    // some SDOs contain a seperate helper AO
    if (name(pointer) === 'emu-clause') {
      pointer = nextEle(pointer);
    }
    if (pointer != null) {
      console.log(parent.innerHTML);
      console.log('------------');
      throw new Error('unexpected node: ' + name(pointer));
    }

    if (parent.parentElement.children.length == 1) {
      throw new Error('SDO is sole element of its parent')
    }
    clauses.push({ ele: parent, name: sdoName });
  }

  let clausesByName = new Map;
  for (let clause of clauses) {
    if (!clausesByName.has(clause.name)) {
      clausesByName.set(clause.name, []);
    }
    clausesByName.get(clause.name).push(clause);
  }
  clauses = [...clausesByName].filter(p => p[1].length > 1);
  if (clauses.length === 0) {
    console.log('out of clauses!');
    process.exit(0);
  }

  // just do one and then start over
  // this lets us commit after each change without having to think very hard

  let [, eles] = clauses[0];
  let first = true;
  let newLines = [];
  let footer = [];
  let toRemove = [];
  for (let { ele } of eles) {
    let { start, end } = getClauseOffsets(source, dom, ele);
    toRemove.push({ start, end });

    let lines = source.slice(start, end).split('\n');
    while (lines[0] === '') {
      lines.shift();
    }
    while (lines[lines.length - 1] === '') {
      lines.pop();
    }

    if (!lines[0].match(/^ *<emu-clause.*>$/)) {
      throw new Error('clause did not start with emu-clause');
    }
    if (!lines[lines.length - 1].match(/ *<\/emu-clause>$/)) {
      throw new Error('clause did not end with emu-clause');
    }
    lines = lines.slice(1, -1);

    let indent = lines[0].match('^ +(?! )')[0].length;
    lines = lines.map(line => {
      if (line === '') {
        return line;
      }
      if (!line.startsWith(' '.repeat(indent))) {
        throw new Error(`line did not start with ${indent} spaces: ${JSON.stringify(line)}`);
      }
      return line.slice(indent);
    });
    if (!lines[0].startsWith('<h1>')) {
      throw new Error('clause did not start with header');
    }
    if (first) {
      first = false;
    } else {
      lines.shift(); // only need one header
      if (/^ *<p>With parameter/.test(lines[0]) && /^ *<p>With parameter/.test(newLines[1])) {
        lines.shift(); // only need "With parameters [...]" paragraph
      }
    }
    lines = lines.filter(l => !/<emu-see-also-para op="\w+"><\/emu-see-also-para>/.test(l));

    if (lines[lines.length - 1] === '</emu-clause>') {
      // trailing clauses go at the end of the new clause
      let index;
      for (index = lines.length - 2; index >= 0; --index) {
        if (lines[index].startsWith('<emu-clause')) {
          break;
        }
      }
      if (index === -1) {
        console.log(lines);
        throw new Error('could not find open tag for trailing clause');
      }
      footer.push(...lines.splice(index));
    }
    newLines.push(...lines);
  }
  newLines.push(...footer);
  let openTag = `  <emu-clause id="${makeId(eles[0].ele.querySelector('h1').innerHTML)}" type="sdo" aoid="${eles[0].name}">`;
  let newContents = openTag + '\n' + newLines.map(l => l === '' ? '' : '    ' + l).join('\n') + '\n  </emu-clause>\n';

  toRemove.sort((a, b) => b.start - a.start);
  for (let { start, end } of toRemove) {
    source = source.substring(0, start) + source.substring(end);
  }
  let marker = `<!-- insert sdos here -->\n`;
  source = source.split(marker).join('\n' + newContents + marker);
  fs.writeFileSync('./spec.html', source, 'utf8');
  exec(`git commit -am "auto-consolidate ${eles[0].name}"`, { stdio: 'inherit' });
  console.log(`Rewrote ${eles[0].name}`);
  // await ask(`Rewrote ${eles[0].name}; press enter for next item.\n`);
}

(async () => {
  while (true) {
    await go();
  }
})();


function makeId(name) {
  let id = 'sec-';
  if (name.startsWith('Static Semantics: ')) {
    id += 'static-semantics-';
    name = name.slice('Static Semantics: '.length);
  } else if (name.startsWith('Runtime Semantics: ')) {
    id += 'runtime-semantics-';
    name = name.slice('Runtime Semantics: '.length);
  }
  id += name.toLowerCase();
  // the convention seems to be that words are joined without anything to separate them, alas
  // name.split(/(?=[A-Z])/).join('-').toLowerCase();
  return id;
}

function skipHeader(pointer) {
  switch (name(pointer)) {
    case 'p': {
      if (pointer.innerHTML.startsWith('With parameter')) {
        return skipHeader(nextEle(pointer));
      }
      return pointer;
    }
    case 'emu-see-also-para':
    case 'emu-note': {
      return skipHeader(nextEle(pointer));
    }
    default: {
      return pointer;
    }
  }
}

function skipNotes(pointer) {
  while (name(pointer) === 'emu-note') {
    pointer = nextEle(pointer);
  }
  return pointer;
}

function name(node) {
  if (node == null) {
    return null;
  }
  return node.nodeName.toLowerCase();
}

function nextEle(ele) {
  while (true) {
    ele = ele.nextSibling;
    if (!ele) {
      return null;
    }
    if (ele.nodeType === 1) { // Node.ELEMENT_NODE
      return ele;
    }
  }
}

function getClauseOffsets(source, dom, ele) {
  let { startOffset: start, endOffset: end } = dom.nodeLocation(ele);
  while (source[start - 1] === ' ') {
    --start;
  }
  ++end; // trailing newline
  if (source[end] === '\n') {
    ++end; // following newline
  } else if (source[start - 1] === '\n') {
    --start;
  }
  return { start, end };
}

function ask(query) {
  const rl = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}
