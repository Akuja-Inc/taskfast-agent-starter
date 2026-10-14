# Console page template-literal escapes

- A regex escape inside the `src/console-page.ts` page script collapses in the template literal: `\w` reaches the browser as a plain `w`, so double every backslash (`\\w`, `\\.`) and pin the behavior with a test that boots the served page. (issue #32)
