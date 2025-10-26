# ActionPacks (PoC)

Tiny, universal “ActionPacks” system: compose packs (tools + JSON Schemas), generate governance policies, dry-run
(schema + policy validation), and export MCP-ready bundles. Includes a demo “host” runner.

## Quickstart

```bash
git clone https://github.com/doninones/actionpacks.git
cd actionpacks
npm install

# Catalog
npm -w @actionpacks/cli run dev -- catalog list

# Fresh stack
rm -rf stacks/it-ops
npm -w @actionpacks/cli run dev -- init stacks/it-ops --name "IT Ops" --env staging
npm -w @actionpacks/cli run dev -- add issues-basic@1.0.0 --stack stacks/it-ops
npm -w @actionpacks/cli run dev -- add email-basic@1.0.0  --stack stacks/it-ops

# Policies
npm -w @actionpacks/cli run dev -- policies suggest --stack stacks/it-ops

# Dry-run and Exec (mock)
npm -w @actionpacks/cli run dev -- dry-run --tool issues-basic@1.0.0:create_issue --stack stacks/it-ops --file ../../samples/create_issue.ok.json --assume-yes
npm -w @actionpacks/cli run dev -- exec    --tool email-basic@1.0.0:send_email   --stack stacks/it-ops --file ../../samples/send_email.ok.json --assume-yes

# Export + Publish
npm run export:mcp
npm run publish:mcp

# Demo host (from exported bundle)
npm -w @actionpacks/cli run host:demo -- --bundle ../../dist/it-ops-mcp --tool issues-basic@1.0.0:create_issue --file ../../samples/create_issue.ok.json --assume-yes
npm -w @actionpacks/cli run host:demo -- --bundle ../../dist/it-ops-mcp --tool email-basic@1.0.0:send_email   --file ../../samples/send_email.ok.json          # expect confirm (exit 2)
npm -w @actionpacks/cli run host:demo -- --bundle ../../dist/it-ops-mcp --tool email-basic@1.0.0:send_email   --file ../../samples/send_email.ok.json --assume-yes
```
