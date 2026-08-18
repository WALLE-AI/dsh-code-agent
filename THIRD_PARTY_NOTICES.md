# Third-party notices

## dsh-TUI — brand art

`packages/dsh-tui/src/brand.ts` reuses two pieces of artwork from the
[`dsh-TUI`](https://github.com/ccch1mneyyy) project:

- the DeepSeek pixel whale sprite (the `standard` frame of its `whaleFrames.ts`,
  a 40x25 hand-drawn sprite in a four-tone palette), and
- the five-row block font glyph table from its `bigfont.ts`.

Only the artwork data is reused. The painters in `brand.ts` are ours: the
original renderers are built on that project's forked Ink and emit ANSI
directly, whereas ours produce the same `DetailLine`/`StyledSegment` rows as the
rest of this transcript and degrade through the same capability layer.

```
MIT License

Copyright (c) 2026, chimney (ccch1mneyyy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### What is deliberately not reused

That project's `src/ink/` — its forked renderer — is not vendored here, in whole
or in part. Its own provenance audit
(`docs/project-documentation/origin.md`) classifies 57 of its files (20.2%) as
`cc-port`, its term for material ported from leaked Claude Code source, and the
tree still carries the matching markers. The artwork above is in neither that
set nor adjacent to it: it is the project's own hand-drawn work, which is why it
is reused and the renderer is not.

Interaction design — key bindings, layout conventions, the shape of the startup
banner — is taken from that project's public documentation and is not covered by
this notice: behaviour is not authorship.
