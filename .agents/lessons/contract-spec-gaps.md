# Contract spec gaps

- The vendored OpenAPI text can lag what the server accepts: the 0.22.0 spec lists no Office MIME types, so `test/tools-contract.test.ts` carves out `.docx`, `.xls` and `.xlsx`; confirm a new gap against the CLI release notes and the server's `storage.ex` before widening that carve-out. (#89)
