/**
 * `applyDiff` on the V4A diffs of the `apply_patch` tool. The first cases
 * are the test cases of `applyDiff` in the OpenAI Agents SDK
 * (openai/openai-agents-js, MIT License, Copyright (c) 2025 OpenAI), with
 * the same inputs and the same expected output. The cases after them cover
 * the matching rules, the error of each malformed diff, and the line ending.
 */
import { describe, expect, it } from 'vitest';
import { applyDiff } from '../src/apply-diff.ts';

const join = (...lines: string[]): string => lines.join('\n');
const nl = (...lines: string[]): string => `${lines.join('\n')}\n`;

interface Accepted {
	readonly name: string;
	readonly input: string;
	readonly diff: string;
	readonly expected: string;
	readonly mode?: 'default' | 'create';
}

const accepted: readonly Accepted[] = [
	{
		name: 'adds lines to an empty input with a floating hunk',
		input: '',
		diff: join('@@', '+hello', '+world'),
		expected: 'hello\nworld\n',
	},
	{
		name: 'reads plus-prefixed content in create mode',
		input: '',
		diff: join('+hello', '+world', '+'),
		expected: 'hello\nworld\n',
		mode: 'create',
	},
	{
		name: 'applies a floating hunk with no marker and no line numbers',
		input: join('- Milk', '- Bread', '- Eggs', '- Apples', '- Coffee'),
		diff: join(
			'@@',
			' - Milk',
			' - Bread',
			' - Eggs',
			'-- Apples',
			'-- Coffee',
			'+- [x] Apples',
			'+- [x] Coffee',
		),
		expected: join('- Milk', '- Bread', '- Eggs', '- [x] Apples', '- [x] Coffee'),
	},
	{
		name: 'keeps CRLF for an insertion hunk',
		input: 'alpha\r\nbeta\r\n',
		diff: '@@\n alpha\n+inserted\n beta',
		expected: 'alpha\r\ninserted\r\nbeta\r\n',
	},
	{
		name: 'keeps CRLF for a replacement hunk',
		input: 'alpha\r\nbeta\r\n',
		diff: '@@\n alpha\n-beta\n+gamma',
		expected: 'alpha\r\ngamma\r\n',
	},
	{
		name: 'keeps CRLF for an insertion at the end with no final newline',
		input: 'alpha\r\nbeta',
		diff: '@@\n alpha\n beta\n+inserted',
		expected: 'alpha\r\nbeta\r\ninserted',
	},
	{
		name: 'keeps CRLF for a replacement at the end with no final newline',
		input: 'alpha\r\nbeta',
		diff: '@@\n alpha\n-beta\n+gamma',
		expected: 'alpha\r\ngamma',
	},
	{
		name: 'keeps mixed line endings byte for byte outside the inserted LF content',
		input: 'alpha\r\nbeta\ngamma',
		diff: '@@\n alpha\r\n beta\n+inserted\n gamma',
		expected: 'alpha\r\nbeta\ninserted\ngamma',
	},
	{
		name: 'applies a replacement with an anchor and context',
		input: nl('line1', 'line2', 'line3'),
		diff: join('@@ line1', '-line2', '+updated', ' line3'),
		expected: nl('line1', 'updated', 'line3'),
	},
	{
		name: 'applies a deletion',
		input: nl('keep', 'remove me', 'stay'),
		diff: join('@@ keep', '-remove me', ' stay'),
		expected: nl('keep', 'stay'),
	},
	{
		name: 'appends at the end of the file and keeps the final newline',
		input: 'a\nb\n',
		diff: join('@@', '+c', '*** End of File'),
		expected: 'a\nb\nc\n',
	},
	{
		name: 'appends at the end of the file and keeps a missing final newline',
		input: 'a\nb',
		diff: join('@@', '+c', '*** End of File'),
		expected: 'a\nb\nc',
	},
	{
		name: 'matches the context of an end-of-file hunk at its final occurrence',
		input: 'start\nx\nfoo\ny\nfoo\n',
		diff: join('@@', '-start', '+updated', '@@', ' foo', '+added', '*** End of File'),
		expected: 'updated\nx\nfoo\ny\nfoo\nadded\n',
	},
	{
		name: 'keeps an intentional blank line before an end-of-file append',
		input: 'a\n\n',
		diff: join('@@', '+b', '*** End of File'),
		expected: 'a\n\nb\n',
	},
	{
		name: 'renames a method under a class anchor',
		input: nl(
			'class Foo:',
			'    def baz(self):',
			'        return f"foo {randint()}"',
			'',
			'def main():',
			'    foo = Foo()',
			'    print(foo.baz())',
		),
		diff: join(
			'@@ class Foo:',
			'-    def baz(self):',
			'+    def rand(self):',
			'        return f"foo {randint()}"',
			'@@ def main():',
			'     foo = Foo()',
			'-    print(foo.baz())',
			'+    print(foo.rand())',
		),
		expected: nl(
			'class Foo:',
			'    def rand(self):',
			'        return f"foo {randint()}"',
			'',
			'def main():',
			'    foo = Foo()',
			'    print(foo.rand())',
		),
	},
	{
		name: 'applies stacked anchors in sequence',
		input: nl(
			'class BaseClass',
			'    def search():',
			'        pass',
			'',
			'class Subclass',
			'    def search():',
			'        pass',
		),
		diff: join(
			'@@ class BaseClass',
			'@@     def search():',
			'-        pass',
			'+        raise NotImplementedError()',
			'@@ class Subclass',
			'@@     def search():',
			'-        pass',
			'+        raise NotImplementedError()',
		),
		expected: nl(
			'class BaseClass',
			'    def search():',
			'        raise NotImplementedError()',
			'',
			'class Subclass',
			'    def search():',
			'        raise NotImplementedError()',
		),
	},
	{
		name: 'reuses a prior parent anchor across stacked hunks',
		input: nl(
			'class Target',
			'    def first():',
			'        pass',
			'',
			'    def second():',
			'        pass',
		),
		diff: join(
			'@@ class Target',
			'@@     def first():',
			'-        pass',
			'+        return 1',
			'@@ class Target',
			'@@     def second():',
			'-        pass',
			'+        return 2',
		),
		expected: nl(
			'class Target',
			'    def first():',
			'        return 1',
			'',
			'    def second():',
			'        return 2',
		),
	},
	{
		name: 'uses each stacked anchor to narrow the target',
		input: nl(
			'class First',
			'    def target():',
			'        return 0',
			'',
			'class Second',
			'    def helper():',
			'        pass',
			'',
			'    def target():',
			'        pass',
		),
		diff: join('@@ class Second', '@@     def target():', '-        pass', '+        return 1'),
		expected: nl(
			'class First',
			'    def target():',
			'        return 0',
			'',
			'class Second',
			'    def helper():',
			'        pass',
			'',
			'    def target():',
			'        return 1',
		),
	},
	{
		name: 'accepts a trailing bare anchor in a stack',
		input: 'class Only\n    def run():\n        pass\n',
		diff: join('@@ class Only', '@@', '-        pass', '+        return 1'),
		expected: 'class Only\n    def run():\n        return 1\n',
	},
	{
		name: 'treats line-number markers as context anchors',
		input: 'one\ntwo\n',
		diff: join('@@ -1,2 +1,2 @@', ' one', '-two', '+2'),
		expected: 'one\n2\n',
	},
	{
		name: 'Example 1: README.md basic replacement',
		input: join('Hello, world!', 'This is my project.'),
		diff: join('-Hello, world!', '+Hello, V4A diff format!'),
		expected: join('Hello, V4A diff format!', 'This is my project.'),
	},
	{
		name: 'Example 2: greet.py function replacement',
		input: join(
			'def greet(name):',
			'    return "Hello " + name',
			'',
			'if __name__ == "__main__":',
			'    print(greet("Alice"))',
		),
		diff: join(
			'-def greet(name):',
			'-    return "Hello " + name',
			'+def greet(name: str) -> str:',
			'+    return f"Hello, {name}!"',
		),
		expected: join(
			'def greet(name: str) -> str:',
			'    return f"Hello, {name}!"',
			'',
			'if __name__ == "__main__":',
			'    print(greet("Alice"))',
		),
	},
	{
		name: 'Example 3: config.yml toggle debug flag',
		input: join('env: dev', 'debug: false', 'log_level: info'),
		diff: join(' env: dev', '-debug: false', '+debug: true', ' log_level: info'),
		expected: join('env: dev', 'debug: true', 'log_level: info'),
	},
	{
		name: 'Example 4: app.py insert import sys',
		input: join(
			'import os',
			'',
			'def main():',
			'    print("Running app")',
			'',
			'if __name__ == "__main__":',
			'    main()',
		),
		diff: join(
			' import os',
			'+import sys',
			'',
			' def main():',
			'     print("Running app")',
			'',
			' if __name__ == "__main__":',
			'     main()',
		),
		expected: join(
			'import os',
			'import sys',
			'',
			'def main():',
			'    print("Running app")',
			'',
			'if __name__ == "__main__":',
			'    main()',
		),
	},
	{
		name: 'Example 5: service.py remove debug logging',
		input: join(
			'def handle_request(req):',
			'    print("DEBUG: got request", req)',
			'    return {"status": "ok"}',
		),
		diff: join(
			' def handle_request(req):',
			'-    print("DEBUG: got request", req)',
			'     return {"status": "ok"}',
		),
		expected: join('def handle_request(req):', '    return {"status": "ok"}'),
	},
	{
		name: 'Example 6: math_utils.py update add() with @@ context',
		input: join('def add(a, b):', '    return a + b', '', 'def mul(a, b):', '    return a * b'),
		diff: join(
			'@@',
			'-def add(a, b):',
			'-    return a + b',
			'+def add(a: int, b: int) -> int:',
			'+    """Add two integers."""',
			'+    return a + b',
		),
		expected: join(
			'def add(a: int, b: int) -> int:',
			'    """Add two integers."""',
			'    return a + b',
			'',
			'def mul(a, b):',
			'    return a * b',
		),
	},
	{
		name: 'Example 7: repository.py update get_user method',
		input: join(
			'class UserRepository:',
			'    def get_user(self, user_id):',
			'        raise NotImplementedError',
			'',
			'    def save_user(self, user):',
			'        raise NotImplementedError',
		),
		diff: join(
			'@@ class UserRepository:',
			'     def get_user(self, user_id):',
			'-        raise NotImplementedError',
			'+        """Fetch a user by ID or return None."""',
			'+        return self._db.get(user_id)',
		),
		expected: join(
			'class UserRepository:',
			'    def get_user(self, user_id):',
			'        """Fetch a user by ID or return None."""',
			'        return self._db.get(user_id)',
			'',
			'    def save_user(self, user):',
			'        raise NotImplementedError',
		),
	},
	{
		name: 'Example 8: settings.py bump timeout',
		input: join('API_URL = "https://api.example.com"', 'TIMEOUT_SECONDS = 5', 'RETRIES = 1'),
		diff: join(
			' API_URL = "https://api.example.com"',
			'-TIMEOUT_SECONDS = 5',
			'+TIMEOUT_SECONDS = 10',
			' RETRIES = 1',
		),
		expected: join('API_URL = "https://api.example.com"', 'TIMEOUT_SECONDS = 10', 'RETRIES = 1'),
	},
	{
		name: 'Example 9: docs/intro.txt create file',
		input: '',
		diff: join('+Welcome to the project!', '+This documentation will guide you through setup.'),
		expected: join('Welcome to the project!', 'This documentation will guide you through setup.'),
		mode: 'create',
	},
	{
		name: 'Example 10: utils/strings.py create module',
		input: '',
		diff: join(
			'+def slugify(text: str) -> str:',
			'+    return text.lower().replace(" ", "-")',
			'+',
			'+__all__ = ["slugify"]',
		),
		expected: join(
			'def slugify(text: str) -> str:',
			'    return text.lower().replace(" ", "-")',
			'',
			'__all__ = ["slugify"]',
		),
		mode: 'create',
	},
	{
		name: 'Example 11: app.py create',
		input: '',
		diff: join('+def run():', '+    print("Hello from app.run()")', '+'),
		expected: nl('def run():', '    print("Hello from app.run()")'),
		mode: 'create',
	},
	{
		name: 'Example 11: main.py update',
		input: join('from app import run', '', 'if __name__ == "__main__":', '    run()'),
		diff: join(
			'-from app import run',
			'+from app import run',
			' ',
			' if __name__ == "__main__":',
			'     run()',
		),
		expected: join('from app import run', '', 'if __name__ == "__main__":', '    run()'),
	},
	{
		name: 'Example 12: LICENSE create file with blank line',
		input: '',
		diff: join('+MIT License', '+', '+Copyright (c) 2025'),
		expected: join('MIT License', '', 'Copyright (c) 2025'),
		mode: 'create',
	},
	{
		name: 'Example 13: an empty diff leaves the content as it is',
		input: join('DEBUG something...', 'more debug...'),
		diff: '',
		expected: join('DEBUG something...', 'more debug...'),
	},
	{
		name: 'Example 14: a context-only diff leaves the content as it is',
		input: 'Legacy content',
		diff: ' Legacy content',
		expected: 'Legacy content',
	},
	{
		name: 'Example 15: client.py update',
		input: 'BASE_URL = "https://old.example.com"',
		diff: join('-BASE_URL = "https://old.example.com"', '+BASE_URL = "https://api.example.com"'),
		expected: 'BASE_URL = "https://api.example.com"',
	},
	{
		name: 'Example 15: version.py update',
		input: 'VERSION = "1.0.0"',
		diff: join('-VERSION = "1.0.0"', '+VERSION = "1.1.0"'),
		expected: 'VERSION = "1.1.0"',
	},
	{
		name: 'Example 16: tests/test_math.py insert test_sub',
		input: join(
			'def test_add():',
			'    assert add(1, 2) == 3',
			'',
			'def test_mul():',
			'    assert mul(2, 3) == 6',
		),
		diff: join(
			' def test_add():',
			'     assert add(1, 2) == 3',
			'',
			'+def test_sub():',
			'+    assert sub(5, 2) == 3',
			'+',
			' def test_mul():',
			'     assert mul(2, 3) == 6',
		),
		expected: join(
			'def test_add():',
			'    assert add(1, 2) == 3',
			'',
			'def test_sub():',
			'    assert sub(5, 2) == 3',
			'',
			'def test_mul():',
			'    assert mul(2, 3) == 6',
		),
	},
	{
		name: 'Example 17: footer.txt update last two lines',
		input: join('Line A', 'Line B', 'Line C'),
		diff: join(' Line A', '-Line B', '-Line C', '+Line B (updated)', '+Line C (updated)'),
		expected: join('Line A', 'Line B (updated)', 'Line C (updated)'),
	},
	{
		name: 'Example 18: docs/guide.md update heading and intro',
		input: join(
			'# Getting Started',
			'',
			'This is the old intro text.',
			'',
			'## Installation',
			'',
			'Steps go here.',
		),
		diff: join(
			'-# Getting Started',
			'-',
			'-This is the old intro text.',
			'+# Quick Start Guide',
			'+',
			'+This is the updated introduction, with clearer instructions.',
			'',
			' ## Installation',
		),
		expected: join(
			'# Quick Start Guide',
			'',
			'This is the updated introduction, with clearer instructions.',
			'',
			'## Installation',
			'',
			'Steps go here.',
		),
	},
	{
		name: 'Example 19: config.json enabled -> true',
		input: join('{', '  "name": "demo",', '  "enabled": false,', '  "retries": 3', '}'),
		diff: join(
			' {',
			'   "name": "demo",',
			'-  "enabled": false,',
			'+  "enabled": true,',
			'   "retries": 3',
			' }',
		),
		expected: join('{', '  "name": "demo",', '  "enabled": true,', '  "retries": 3', '}'),
	},
	{
		name: 'Example 20: web/app.js update add() and greet()',
		input: join(
			'function add(a, b) {',
			'  return a + b;',
			'}',
			'',
			'function greet(name) {',
			'  return "Hello " + name;',
			'}',
		),
		diff: join(
			'@@',
			'-function add(a, b) {',
			'-  return a + b;',
			'-}',
			'+function add(a, b) {',
			'+  return a + b; // simple add',
			'+}',
			' ',
			' function greet(name) {',
			'-  return "Hello " + name;',
			'-}',
			`+  return \`Hello \${name}!\`;`,
			'+}',
		),
		expected: join(
			'function add(a, b) {',
			'  return a + b; // simple add',
			'}',
			'',
			'function greet(name) {',
			`  return \`Hello \${name}!\`;`,
			'}',
		),
	},
	{
		name: 'Example 21: controller.py insert logging after validate',
		input: join('def handle(req):', '    validate(req)', '    return process(req)'),
		diff: join(
			'@@ def handle(req):',
			'     validate(req)',
			'+    log_request(req)',
			'     return process(req)',
		),
		expected: join(
			'def handle(req):',
			'    validate(req)',
			'    log_request(req)',
			'    return process(req)',
		),
	},
	{
		name: 'Example 22: greeter.py update main print message',
		input: join(
			'class Greeter:',
			'    def hello(self):',
			'        return "hi"',
			'',
			'def main():',
			'    g = Greeter()',
			'    print(g.hello())',
		),
		diff: join(
			'@@ def main():',
			'     g = Greeter()',
			'-    print(g.hello())',
			'+    print(f"Greeting: {g.hello()}")',
		),
		expected: join(
			'class Greeter:',
			'    def hello(self):',
			'        return "hi"',
			'',
			'def main():',
			'    g = Greeter()',
			'    print(f"Greeting: {g.hello()}")',
		),
	},
];

describe('applyDiff of the OpenAI test cases', () => {
	it.each(accepted)('$name', ({ input, diff, expected, mode }) => {
		expect(applyDiff(input, diff, mode)).toBe(expected);
	});

	it('rejects a create diff with no + prefixes', () => {
		expect(() => applyDiff('', join('line1', 'line2'), 'create')).toThrow();
	});

	it('rejects partially matched stacked anchors', () => {
		const input = nl(
			'class Target',
			'    def helper():',
			'        pass',
			'',
			'    def desired():',
			'        return 1',
		);
		const diff = join(
			'@@ class Target',
			'@@     def missing():',
			'-        pass',
			'+        return 99',
		);
		expect(() => applyDiff(input, diff)).toThrow('Invalid Anchor');
	});

	it('rejects a stacked diff when its first anchor is missing', () => {
		const input = nl('class Wrong', '    def desired():', '        pass');
		const diff = join(
			'@@ class Target',
			'@@     def desired():',
			'-        pass',
			'+        return 99',
		);
		expect(() => applyDiff(input, diff)).toThrow('Invalid Anchor');
	});

	it('rejects a missing anchor followed by a bare marker', () => {
		expect(() => applyDiff('a\nb\n', join('@@ missing', '@@', '-b', '+B'))).toThrow(
			'Invalid Anchor',
		);
	});

	it('throws on a context mismatch', () => {
		const diff = join('@@ -1,2 +1,2 @@', ' x', '-two', '+2');
		expect(() => applyDiff('one\ntwo\n', diff)).toThrow();
	});
});

describe('the matching rules', () => {
	it.each([
		{
			name: 'a line whose end differs in whitespace',
			input: 'alpha  \nbeta\n',
			diff: join(' alpha', '-beta', '+BETA'),
			expected: 'alpha  \nBETA\n',
		},
		{
			name: 'a line whose start and end differ in whitespace',
			input: '  alpha  \nbeta\n',
			diff: join(' alpha', '-beta', '+BETA'),
			expected: '  alpha  \nBETA\n',
		},
		{
			name: 'a context line that is exact in preference to a trimmed one',
			input: 'x \nx\nend\n',
			diff: join(' x', '+added', ' end'),
			expected: 'x \nx\nadded\nend\n',
		},
		{
			name: 'a deleted line that differs in its indent',
			input: 'a\n    b\nc\n',
			diff: join(' a', '-b', ' c'),
			expected: 'a\nc\n',
		},
		{
			name: 'an anchor that differs in its indent',
			input: 'one\n    def run():\n        pass\n',
			diff: join('@@ def run():', '-        pass', '+        return 1'),
			expected: 'one\n    def run():\n        return 1\n',
		},
		{
			name: 'an anchor that sits before the cursor',
			input: 'head\nx\ny\ntail\n',
			diff: join(' head', ' x', '@@ head', '-y', '+Y'),
			expected: 'head\nx\nY\ntail\n',
		},
		{
			name: 'an end-of-file hunk whose context is not at the end',
			input: 'a\nb\nc\nd\n',
			diff: join('@@', ' b', '+B', '*** End of File'),
			expected: 'a\nb\nB\nc\nd\n',
		},
		{
			name: 'an end-of-file hunk with no context',
			input: 'a\nb\n',
			diff: join('@@', '+c', '*** End of File'),
			expected: 'a\nb\nc\n',
		},
		{
			name: 'a diff with CRLF line endings',
			input: 'a\nb\nc\n',
			diff: '@@\r\n a\r\n-b\r\n+B\r\n c\r\n',
			expected: 'a\nB\nc\n',
		},
		{
			name: 'a blank line of the diff as an empty context line',
			input: 'a\n\nb\n',
			diff: join(' a', '', '-b', '+B'),
			expected: 'a\n\nB\n',
		},
		{
			name: 'an anchor with no text',
			input: 'a\nb\n',
			diff: join('@@ ', '-a', '+A'),
			expected: 'A\nb\n',
		},
		{
			name: 'an update of a file with no newline at all',
			input: 'only',
			diff: join('-only', '+one'),
			expected: 'one',
		},
		{
			name: 'a file with one newline that is a CRLF',
			input: 'a\r\n',
			diff: join('-a', '+b'),
			expected: 'b\r\n',
		},
		{
			name: 'a file with a bare LF after a CRLF',
			input: 'a\r\nb\n',
			diff: join(' a', '-b', '+c'),
			expected: 'a\r\nc\n',
		},
		{
			name: 'a deletion of every line',
			input: 'a\nb\n',
			diff: join('-a', '-b'),
			expected: '',
		},
		{
			name: 'a change with a delete, an insert, and a later delete in one block',
			input: 'a\nb\nc\nd\n',
			diff: join(' a', '-b', '+X', '-c', ' d'),
			expected: 'a\nX\nd\n',
		},
		{
			name: 'two blocks of change that context lines separate',
			input: 'a\nb\nc\nd\ne\n',
			diff: join('-a', '+A', ' b', ' c', ' d', '-e', '+E'),
			expected: 'A\nb\nc\nd\nE\n',
		},
	])('applies $name', ({ input, diff, expected }) => {
		expect(applyDiff(input, diff)).toBe(expected);
	});

	it('handles a file of many thousand lines', () => {
		const input = `${Array.from({ length: 300_000 }, (_, index) => `line ${index}`).join('\n')}\n`;
		const diff = join(' line 299998', '-line 299999', '+last');
		const output = applyDiff(input, diff);
		expect(output.endsWith('line 299998\nlast\n')).toBe(true);
		expect(output.length).toBeLessThan(input.length);
	});
});

describe('a diff that does not apply', () => {
	it.each([
		{
			name: 'a context that is not in the file',
			input: 'one\ntwo\n',
			diff: join(' missing', '-two', '+2'),
			message: 'Invalid Context 0:\nmissing\ntwo',
		},
		{
			name: 'a context that comes before the cursor',
			input: 'a\nb\nc\n',
			diff: join(' b', '+X', '@@', ' a', '+Y'),
			message: 'Invalid Context 2:\na',
		},
		{
			name: 'an end-of-file context that is not in the file',
			input: 'a\nb\n',
			diff: join('@@', ' zzz', '+c', '*** End of File'),
			message: 'Invalid EOF Context 0:\nzzz',
		},
		{
			name: 'a second section with no anchor',
			input: 'a\nb\nc\n',
			diff: join(' a', '+A', '*** End of File', ' b', '+B'),
			message: 'Invalid Line:\n b',
		},
		{
			name: 'a line that starts with no marker',
			input: 'a\n',
			diff: join('@@', 'oops'),
			message: 'Invalid Line: oops',
		},
		{
			name: 'a line that starts with *** and is no marker',
			input: 'a\n',
			diff: join('@@', ' a', '*** Rename File: b'),
			message: 'Invalid Line: *** Rename File: b',
		},
		{
			name: 'a bare *** line',
			input: 'a\n',
			diff: join('@@', '***'),
			message: 'Nothing in this section - index=1 ***',
		},
		{
			name: 'an anchor with nothing after it',
			input: 'a\n',
			diff: '@@ a',
			message: 'Nothing in this section - index=1 *** End Patch',
		},
		{
			name: 'two chunks that overlap',
			input: 'a\nb\n',
			diff: join('@@', ' a', '-b', '@@', '-b', '*** End of File'),
			message: 'applyDiff: overlapping chunk at 1 (cursor 2)',
		},
	])('throws for $name', ({ input, diff, message }) => {
		expect(() => applyDiff(input, diff)).toThrow(message);
	});

	it.each([
		{ name: 'a line with no +', diff: join('+a', 'b'), message: 'Invalid Add File Line: b' },
		{ name: 'an empty line', diff: join('+a', '', '+b'), message: 'Invalid Add File Line: ' },
		{
			name: 'an end-of-file marker',
			diff: join('+a', '*** End of File'),
			message: 'Invalid Add File Line: *** End of File',
		},
	])('throws in create mode for $name', ({ diff, message }) => {
		expect(() => applyDiff('', diff, 'create')).toThrow(message);
	});

	it('gives an empty file from an empty create diff', () => {
		expect(applyDiff('', '', 'create')).toBe('');
	});

	it('stops a create diff at the line of a file header', () => {
		expect(applyDiff('', join('+a', '*** Update File: x', '+b'), 'create')).toBe('a');
	});
});
