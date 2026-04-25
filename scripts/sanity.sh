echo "ensure config.json exists"
cp artifacts/api-server/config.json.example artifacts/api-server/config.json


echo "setup db migrations"
pnpm --filter @workspace/db run push      