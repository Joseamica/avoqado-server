# Neon Database Branching Integration

This project uses Neon's database branching feature with GitHub Actions to automatically create isolated database environments for each pull
request.

## How It Works

### Automatic Branch Creation

- When you create a new pull request, GitHub Actions automatically creates a new Neon database branch
- The branch name follows the pattern: `pr-{pr_number}` (e.g., `pr-123`)
- Each branch gets its own isolated database with the same schema as production

### Database Setup

- Migrations are automatically applied to the new branch
- Database is seeded with test data for development
- You get a unique connection string for testing your changes

### Clean Up

- When you close or merge the pull request, the database branch is automatically deleted
- No manual cleanup required

## Configuration

### Required GitHub Secrets

Make sure these secrets are configured in your repository:

- `NEON_API_KEY`: Your Neon API key
- `NEON_PROJECT_ID`: Your Neon project ID

### Supported Events

The workflow triggers on:

- Pull request opened
- Pull request reopened
- Pull request synchronized (new commits)
- Pull request closed

## Development Workflow

1. **Create a branch** and make your database schema changes
2. **Open a pull request** - this automatically creates a Neon database branch
3. **Test your changes** using the isolated database environment
4. **Merge or close** the PR - the database branch is automatically cleaned up

## Benefits

✅ **Isolated Testing**: Each PR gets its own database, preventing conflicts  
✅ **Automatic Setup**: No manual database management required  
✅ **Production Parity**: Same schema and data structure as production  
✅ **Easy Cleanup**: Branches are automatically deleted when PR is closed  
✅ **Cost Effective**: Only pay for active branches during development

## Neon Projects

- **Development**: `muddy-band-82943019` (staging-avoqado-db) - Oregon
- **Production**: `orange-firefly-82973735` (production-avoqado-db) - Virginia

## Connection Strings

The workflow outputs database connection strings that can be used in your application:

- `db_url`: Standard connection string
- `db_url_with_pooler`: Connection string with connection pooling

## Monitoring

You can monitor your database branches in the [Neon Console](https://console.neon.tech):

- View all active branches
- Monitor resource usage
- Access query performance metrics
- Manage branch settings
