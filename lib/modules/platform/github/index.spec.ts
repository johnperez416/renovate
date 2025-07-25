import { RequestError } from 'got';
import { DateTime } from 'luxon';
import { mockDeep } from 'vitest-mock-extended';
import { GlobalConfig } from '../../../config/global';
import {
  PLATFORM_RATE_LIMIT_EXCEEDED,
  PLATFORM_UNKNOWN_ERROR,
  REPOSITORY_CANNOT_FORK,
  REPOSITORY_FORKED,
  REPOSITORY_FORK_MISSING,
  REPOSITORY_NOT_FOUND,
  REPOSITORY_RENAMED,
} from '../../../constants/error-messages';
import { ExternalHostError } from '../../../types/errors/external-host-error';
import * as repository from '../../../util/cache/repository';
import * as _git from '../../../util/git';
import type { LongCommitSha } from '../../../util/git/types';
import * as _hostRules from '../../../util/host-rules';
import { setBaseUrl } from '../../../util/http/github';
import { toBase64 } from '../../../util/string';
import { hashBody } from '../pr-body';
import type {
  CreatePRConfig,
  ReattemptPlatformAutomergeConfig,
  UpdatePrConfig,
} from '../types';
import * as branch from './branch';
import type { ApiPageCache, GhRestPr } from './types';
import * as github from '.';
import * as httpMock from '~test/http-mock';
import { logger } from '~test/util';

const githubApiHost = 'https://api.github.com';

vi.mock('timers/promises');

vi.mock('../../../util/host-rules', () => mockDeep());
vi.mock('../../../util/http/queue');
const hostRules = vi.mocked(_hostRules);

const git = vi.mocked(_git);

describe('modules/platform/github/index', () => {
  beforeEach(() => {
    github.resetConfigs();

    setBaseUrl(githubApiHost);

    git.isBranchBehindBase.mockResolvedValue(true);
    git.getBranchCommit.mockReturnValue(
      '0d9c7726c3d628b7e28af234595cfd20febdbf8e' as LongCommitSha,
    );
    hostRules.find.mockReturnValue({
      token: '123test',
    });

    const repoCache = repository.getCache();
    delete repoCache.platform;
    delete process.env.RENOVATE_X_GITHUB_HOST_RULES;
  });

  describe('initPlatform()', () => {
    it('should throw if no token', async () => {
      await expect(github.initPlatform({})).rejects.toThrow(
        'Init: You must configure a GitHub token',
      );
    });

    it('should throw if using fine-grained token with GHE <3.10', async () => {
      httpMock
        .scope('https://ghe.renovatebot.com')
        .head('/')
        .reply(200, '', { 'x-github-enterprise-version': '3.9.0' });
      await expect(
        github.initPlatform({
          endpoint: 'https://ghe.renovatebot.com',
          token: 'github_pat_XXXXXX',
        }),
      ).rejects.toThrow(
        'Init: Fine-grained Personal Access Tokens do not support GitHub Enterprise Server API version <3.10 and cannot be used with Renovate.',
      );
    });

    it('should throw if using fine-grained token with GHE unknown version', async () => {
      httpMock.scope('https://ghe.renovatebot.com').head('/').reply(200);
      await expect(
        github.initPlatform({
          endpoint: 'https://ghe.renovatebot.com',
          token: 'github_pat_XXXXXX',
        }),
      ).rejects.toThrow(
        'Init: Fine-grained Personal Access Tokens do not support GitHub Enterprise Server API version <3.10 and cannot be used with Renovate.',
      );
    });

    it('should support fine-grained token with GHE >=3.10', async () => {
      httpMock
        .scope('https://ghe.renovatebot.com')
        .head('/')
        .reply(200, '', { 'x-github-enterprise-version': '3.10.0' })
        .get('/user')
        .reply(200, { login: 'renovate-bot' })
        .get('/user/emails')
        .reply(200, [{ email: 'user@domain.com' }]);
      expect(
        await github.initPlatform({
          endpoint: 'https://ghe.renovatebot.com',
          token: 'github_pat_XXXXXX',
        }),
      ).toEqual({
        endpoint: 'https://ghe.renovatebot.com/',
        gitAuthor: 'undefined <user@domain.com>',
        renovateUsername: 'renovate-bot',
        token: 'github_pat_XXXXXX',
      });
    });

    it('should throw if user failure', async () => {
      httpMock.scope(githubApiHost).get('/user').reply(404);
      await expect(github.initPlatform({ token: '123test' })).rejects.toThrow();
    });

    it('should support default endpoint no email access', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/user')
        .reply(200, {
          login: 'renovate-bot',
        })
        .get('/user/emails')
        .reply(400);
      expect(await github.initPlatform({ token: '123test' })).toMatchSnapshot();
    });

    it('should support default endpoint no email result', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/user')
        .reply(200, {
          login: 'renovate-bot',
        })
        .get('/user/emails')
        .reply(200, [{}]);
      expect(await github.initPlatform({ token: '123test' })).toMatchSnapshot();
    });

    it('should support gitAuthor and username', async () => {
      expect(
        await github.initPlatform({
          token: '123test',
          username: 'renovate-bot',
          gitAuthor: 'renovate@whitesourcesoftware.com',
        }),
      ).toMatchSnapshot();
    });

    it('should support default endpoint with email', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/user')
        .reply(200, {
          login: 'renovate-bot',
        })
        .get('/user/emails')
        .reply(200, [
          {
            email: 'user@domain.com',
          },
        ]);
      expect(await github.initPlatform({ token: '123test' })).toMatchSnapshot();
    });

    it('should autodetect email/user on default endpoint with GitHub App', async () => {
      process.env.RENOVATE_X_GITHUB_HOST_RULES = 'true';
      httpMock
        .scope(githubApiHost, {
          reqheaders: {
            authorization: 'token ghs_123test',
          },
        })
        .post('/graphql')
        .reply(200, {
          data: { viewer: { login: 'my-app[bot]', databaseId: 12345 } },
        });
      expect(
        await github.initPlatform({ token: 'x-access-token:ghs_123test' }),
      ).toEqual({
        endpoint: 'https://api.github.com/',
        gitAuthor: 'my-app[bot] <12345+my-app[bot]@users.noreply.github.com>',
        hostRules: [
          {
            hostType: 'docker',
            matchHost: 'ghcr.io',
            password: 'ghs_123test',
            username: 'USERNAME',
          },
          {
            hostType: 'npm',
            matchHost: 'npm.pkg.github.com',
            token: 'ghs_123test',
          },
          {
            hostType: 'rubygems',
            matchHost: 'rubygems.pkg.github.com',
            password: 'ghs_123test',
            username: 'my-app[bot]',
          },
          {
            hostType: 'maven',
            matchHost: 'maven.pkg.github.com',
            password: 'ghs_123test',
            username: 'my-app[bot]',
          },
          {
            hostType: 'nuget',
            matchHost: 'nuget.pkg.github.com',
            password: 'ghs_123test',
            username: 'my-app[bot]',
          },
        ],
        renovateUsername: 'my-app[bot]',
        token: 'x-access-token:ghs_123test',
      });
      expect(await github.initPlatform({ token: 'ghs_123test' })).toEqual({
        endpoint: 'https://api.github.com/',
        gitAuthor: 'my-app[bot] <12345+my-app[bot]@users.noreply.github.com>',
        hostRules: [
          {
            hostType: 'docker',
            matchHost: 'ghcr.io',
            password: 'ghs_123test',
            username: 'USERNAME',
          },
          {
            hostType: 'npm',
            matchHost: 'npm.pkg.github.com',
            token: 'ghs_123test',
          },
          {
            hostType: 'rubygems',
            matchHost: 'rubygems.pkg.github.com',
            password: 'ghs_123test',
            username: 'my-app[bot]',
          },
          {
            hostType: 'maven',
            matchHost: 'maven.pkg.github.com',
            password: 'ghs_123test',
            username: 'my-app[bot]',
          },
          {
            hostType: 'nuget',
            matchHost: 'nuget.pkg.github.com',
            password: 'ghs_123test',
            username: 'my-app[bot]',
          },
        ],
        renovateUsername: 'my-app[bot]',
        token: 'x-access-token:ghs_123test',
      });
    });

    it('should throw error when cant request App information on default endpoint with GitHub App', async () => {
      httpMock.scope(githubApiHost).post('/graphql').reply(200, {});
      await expect(
        github.initPlatform({ token: 'x-access-token:ghs_123test' }),
      ).rejects.toThrowWithMessage(Error, 'Init: Authentication failure');
    });

    it('should autodetect email/user on custom endpoint with GitHub App', async () => {
      httpMock
        .scope('https://ghe.renovatebot.com', {
          reqheaders: {
            authorization: 'token ghs_123test',
          },
        })
        .head('/')
        .reply(200, '', { 'x-github-enterprise-version': '3.0.15' })
        .post('/graphql')
        .reply(200, {
          data: { viewer: { login: 'my-app[bot]', databaseId: 12345 } },
        });
      expect(
        await github.initPlatform({
          endpoint: 'https://ghe.renovatebot.com',
          token: 'x-access-token:ghs_123test',
        }),
      ).toEqual({
        endpoint: 'https://ghe.renovatebot.com/',
        gitAuthor:
          'my-app[bot] <12345+my-app[bot]@users.noreply.ghe.renovatebot.com>',
        renovateUsername: 'my-app[bot]',
        token: 'x-access-token:ghs_123test',
      });
    });

    it('should support custom endpoint', async () => {
      httpMock
        .scope('https://ghe.renovatebot.com')
        .head('/')
        .reply(200, '', { 'x-github-enterprise-version': '3.0.15' })

        .get('/user')
        .reply(200, {
          login: 'renovate-bot',
        })
        .get('/user/emails')
        .reply(200, [
          {
            email: 'user@domain.com',
          },
        ]);
      expect(
        await github.initPlatform({
          endpoint: 'https://ghe.renovatebot.com',
          token: '123test',
        }),
      ).toMatchSnapshot();
    });

    it('should support custom endpoint without version', async () => {
      httpMock
        .scope('https://ghe.renovatebot.com')
        .head('/')
        .reply(200)

        .get('/user')
        .reply(200, {
          login: 'renovate-bot',
        })
        .get('/user/emails')
        .reply(200, [
          {
            email: 'user@domain.com',
          },
        ]);
      expect(
        await github.initPlatform({
          endpoint: 'https://ghe.renovatebot.com',
          token: '123test',
        }),
      ).toMatchSnapshot();
    });
  });

  describe('getRepos', () => {
    it('should return an array of repos', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/user/repos?per_page=100')
        .reply(200, [
          {
            full_name: 'a/b',
            archived: false,
          },
          {
            full_name: 'c/d',
            archived: false,
          },
          {
            full_name: 'e/f',
            archived: true,
          },
          null,
        ]);
      const repos = await github.getRepos();
      expect(repos).toMatchSnapshot();
    });

    it('should filters repositories by topics', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/user/repos?per_page=100')
        .reply(200, [
          {
            full_name: 'a/b',
            archived: false,
            topics: [],
          },
          {
            full_name: 'c/d',
            archived: false,
            topics: ['managed-by-renovate'],
          },
          {
            full_name: 'e/f',
            archived: true,
            topics: ['managed-by-renovate'],
          },
          null,
        ]);

      const repos = await github.getRepos({ topics: ['managed-by-renovate'] });
      expect(repos).toEqual(['c/d']);
    });

    it('should return an array of repos when using Github App endpoint', async () => {
      //Use Github App token
      await github.initPlatform({
        endpoint: githubApiHost,
        username: 'renovate-bot',
        gitAuthor: 'Renovate Bot',
        token: 'x-access-token:123test',
      });
      httpMock
        .scope(githubApiHost)
        .get('/installation/repositories?per_page=100')
        .reply(200, {
          repositories: [
            {
              full_name: 'a/b',
            },
            {
              full_name: 'c/d',
            },
            null,
          ],
        });

      const repos = await github.getRepos();
      expect(repos).toEqual(['a/b', 'c/d']);
    });

    it('should return an array of repos when using GitHub App Installation Token', async () => {
      //Use Github App token
      await github.initPlatform({
        endpoint: githubApiHost,
        username: 'self-hosted-renovate[bot]',
        gitAuthor:
          'Self-hosted Renovate Bot <123456+self-hosted-renovate[bot]@users.noreply.github.com>',
        token: 'ghs_123test',
      });
      httpMock
        .scope(githubApiHost)
        .get('/installation/repositories?per_page=100')
        .reply(200, {
          repositories: [
            {
              full_name: 'a/b',
              archived: false,
            },
            {
              full_name: 'c/d',
              archived: false,
            },
            {
              full_name: 'e/f',
              archived: true,
            },
            null,
          ],
        });

      const repos = await github.getRepos();
      expect(repos).toEqual(['a/b', 'c/d']);
    });
  });

  function initRepoMock(
    scope: httpMock.Scope,
    repository: string,
    other: any = {},
  ): void {
    scope.post(`/graphql`).reply(200, {
      data: {
        repository: {
          isFork: false,
          isArchived: false,
          nameWithOwner: repository,
          autoMergeAllowed: true,
          hasIssuesEnabled: true,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
          squashMergeAllowed: true,
          defaultBranchRef: {
            name: 'master',
            target: {
              oid: '1234',
            },
          },
          ...other,
        },
      },
    });
  }

  function forkInitRepoMock(
    scope: httpMock.Scope,
    repository: string,
    forkExisted: boolean,
    forkResult = 200,
    forkDefaultBranch = 'master',
    isFork = false,
  ): void {
    scope
      // repo info
      .post(`/graphql`)
      .reply(200, {
        data: {
          repository: {
            isFork,
            isArchived: false,
            nameWithOwner: repository,
            hasIssuesEnabled: true,
            mergeCommitAllowed: true,
            rebaseMergeAllowed: true,
            squashMergeAllowed: true,
            defaultBranchRef: {
              name: 'master',
              target: {
                oid: '1234',
              },
            },
          },
        },
      });

    if (!isFork) {
      scope.get(`/repos/${repository}/forks?per_page=100`).reply(
        forkResult,
        forkExisted
          ? [
              {
                full_name: 'forked/repo',
                owner: { login: 'forked' },
                default_branch: forkDefaultBranch,
              },
            ]
          : [],
      );
    }
  }

  describe('initRepo', () => {
    it('should squash', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      const config = await github.initRepo({ repository: 'some/repo' });
      expect(config).toMatchSnapshot();
    });

    it('should fork when using forkToken', async () => {
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, 'some/repo', false);
      scope.get('/user').reply(200, {
        login: 'forked',
      });
      scope.post('/repos/some/repo/forks').reply(200, {
        full_name: 'forked/repo',
        default_branch: 'master',
      });
      const config = await github.initRepo({
        repository: 'some/repo',
        forkToken: 'true',
        forkCreation: true,
      });
      expect(config).toMatchSnapshot();
    });

    it('should throw if fork needed but forkCreation=false', async () => {
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, 'some/repo', false);
      scope.get('/user').reply(200, {
        login: 'forked',
      });
      await expect(
        github.initRepo({
          repository: 'some/repo',
          forkToken: 'true',
          forkCreation: false,
        }),
      ).rejects.toThrow(REPOSITORY_FORK_MISSING);
    });

    it('throws if the repo is a fork', async () => {
      const repo = 'some/repo';
      const branch = 'master';
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, repo, false, 200, branch, true);
      await expect(
        github.initRepo({
          repository: 'some/repo',
          forkToken: 'true',
          forkCreation: true,
        }),
      ).rejects.toThrow(REPOSITORY_FORKED);
    });

    it('throws when cannot fork due to username error', async () => {
      const repo = 'some/repo';
      const branch = 'master';
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, repo, false, 200, branch);
      scope.get('/user').reply(404);
      await expect(
        github.initRepo({
          repository: 'some/repo',
          forkToken: 'true',
          forkCreation: true,
        }),
      ).rejects.toThrow(REPOSITORY_CANNOT_FORK);
    });

    it('throws when listing forks with 404', async () => {
      const repo = 'some/repo';
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, repo, false, 404);
      await expect(
        github.initRepo({
          repository: 'some/repo',
          forkToken: 'true',
          forkCreation: true,
        }),
      ).rejects.toThrow(REPOSITORY_CANNOT_FORK);
    });

    it('throws when listing forks with 500', async () => {
      const repo = 'some/repo';
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, repo, false, 500);
      await expect(
        github.initRepo({
          repository: 'some/repo',
          forkToken: 'true',
          forkCreation: true,
        }),
      ).rejects.toThrow(REPOSITORY_CANNOT_FORK);
    });

    it('throws when error creating fork', async () => {
      const repo = 'some/repo';
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, repo, false);
      scope.get('/user').reply(200, {
        login: 'forked',
      });
      scope.post(`/repos/${repo}/forks`).reply(500);
      await expect(
        github.initRepo({
          repository: 'some/repo',
          forkToken: 'true',
          forkCreation: true,
          forkOrg: 'forked',
        }),
      ).rejects.toThrow(REPOSITORY_CANNOT_FORK);
    });

    it('should update fork when using forkToken and forkOrg', async () => {
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, 'some/repo', true);
      const config = await github.initRepo({
        repository: 'some/repo',
        forkToken: 'true',
        forkCreation: true,
        forkOrg: 'forked',
      });
      expect(config).toMatchSnapshot();
    });

    it('detects fork default branch mismatch', async () => {
      const scope = httpMock.scope(githubApiHost);
      forkInitRepoMock(scope, 'some/repo', true, 200, 'not_master');
      scope.get('/user').reply(200, {
        login: 'forked',
      });
      scope.post('/repos/forked/repo/git/refs').reply(200);
      scope.patch('/repos/forked/repo').reply(200);
      const config = await github.initRepo({
        repository: 'some/repo',
        forkToken: 'true',
        forkCreation: true,
      });
      expect(config).toMatchSnapshot();
    });

    it('should merge', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          data: {
            repository: {
              isFork: false,
              isArchived: false,
              nameWithOwner: 'some/repo',
              hasIssuesEnabled: true,
              mergeCommitAllowed: true,
              rebaseMergeAllowed: true,
              squashMergeAllowed: false,
              defaultBranchRef: {
                name: 'master',
                target: {
                  oid: '1234',
                },
              },
            },
          },
        });
      const config = await github.initRepo({
        repository: 'some/repo',
      });
      expect(config).toMatchSnapshot();
    });

    it('should rebase', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          data: {
            repository: {
              isFork: false,
              isArchived: false,
              nameWithOwner: 'some/repo',
              hasIssuesEnabled: true,
              mergeCommitAllowed: false,
              rebaseMergeAllowed: true,
              squashMergeAllowed: false,
              defaultBranchRef: {
                name: 'master',
                target: {
                  oid: '1234',
                },
              },
            },
          },
        });
      const config = await github.initRepo({ repository: 'some/repo' });
      expect(config).toMatchSnapshot();
    });

    it('should not guess at merge', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          data: {
            repository: {
              defaultBranchRef: {
                name: 'master',
                target: {
                  oid: '1234',
                },
              },
            },
          },
        });
      const config = await github.initRepo({ repository: 'some/repo' });
      expect(config).toMatchSnapshot();
    });

    it('should throw error if archived', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          data: {
            repository: {
              isArchived: true,
              nameWithOwner: 'some/repo',
              hasIssuesEnabled: true,
              defaultBranchRef: {
                name: 'master',
                target: {
                  oid: '1234',
                },
              },
            },
          },
        });
      await expect(
        github.initRepo({ repository: 'some/repo' }),
      ).rejects.toThrow();
    });

    it('throws not-found', async () => {
      httpMock.scope(githubApiHost).post(`/graphql`).reply(404);
      await expect(
        github.initRepo({ repository: 'some/repo' }),
      ).rejects.toThrow(REPOSITORY_NOT_FOUND);
    });

    it('throws unexpected graphql errors', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          errors: [
            {
              type: 'SOME_ERROR_TYPE',
              message: 'Some error message',
            },
          ],
        });
      await expect(
        github.initRepo({ repository: 'some/repo' }),
      ).rejects.toThrow(PLATFORM_UNKNOWN_ERROR);
    });

    it('throws graphql rate limit error', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          errors: [
            {
              type: 'RATE_LIMITED',
              message: 'API rate limit exceeded for installation ID XXXXXXX.',
            },
          ],
        });
      await expect(
        github.initRepo({ repository: 'some/repo' }),
      ).rejects.toThrow(PLATFORM_RATE_LIMIT_EXCEEDED);
    });

    it('should throw error if renamed', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          data: {
            repository: {
              nameWithOwner: 'some/other',
              hasIssuesEnabled: true,
              defaultBranchRef: {
                name: 'master',
                target: {
                  oid: '1234',
                },
              },
            },
          },
        });
      await expect(
        github.initRepo({ repository: 'some/repo' }),
      ).rejects.toThrow(REPOSITORY_RENAMED);
    });

    it('should not be case sensitive', async () => {
      httpMock
        .scope(githubApiHost)
        .post(`/graphql`)
        .reply(200, {
          data: {
            repository: {
              nameWithOwner: 'Some/repo',
              hasIssuesEnabled: true,
              defaultBranchRef: {
                name: 'master',
                target: {
                  oid: '1234',
                },
              },
            },
          },
        });
      const result = await github.initRepo({
        repository: 'some/Repo',
      });
      expect(result.defaultBranch).toBe('master');
      expect(result.isFork).toBeFalse();
    });
  });

  describe('getBranchForceRebase', () => {
    it('should detect repoForceRebase', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/repos/undefined/branches/main/protection')
        .reply(200, {
          required_pull_request_reviews: {
            dismiss_stale_reviews: false,
            require_code_owner_reviews: false,
            required_approving_review_count: 1,
          },
          required_status_checks: {
            strict: true,
            contexts: [],
          },
          restrictions: {
            users: [
              {
                login: 'rarkins',
                id: 6311784,
                type: 'User',
                site_admin: false,
              },
            ],
            teams: [],
          },
        });
      const res = await github.getBranchForceRebase('main');
      expect(res).toBeTrue();
    });

    it('should handle 404', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/repos/undefined/branches/dev/protection')
        .reply(404);
      const res = await github.getBranchForceRebase('dev');
      expect(res).toBeFalse();
    });

    it('should handle 403', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/repos/undefined/branches/main/protection')
        .reply(403);
      const res = await github.getBranchForceRebase('main');
      expect(res).toBeFalse();
    });

    it('should throw 401', async () => {
      httpMock
        .scope(githubApiHost)
        .get('/repos/undefined/branches/main/protection')
        .reply(401);
      await expect(
        github.getBranchForceRebase('main'),
      ).rejects.toThrowErrorMatchingSnapshot();
    });
  });

  describe('getPrList()', () => {
    const t = DateTime.fromISO('2000-01-01T00:00:00.000+00:00');
    const t1 = t.plus({ minutes: 1 }).toISO()!;
    const t2 = t.plus({ minutes: 2 }).toISO()!;
    const t3 = t.plus({ minutes: 3 }).toISO()!;
    const t4 = t.plus({ minutes: 4 }).toISO()!;

    const pr1: GhRestPr = {
      number: 1,
      head: {
        ref: 'branch-1',
        sha: '111' as LongCommitSha,
        repo: { full_name: 'some/repo' },
      },
      base: { repo: { pushed_at: '' }, ref: 'repo/fork_branch' },
      state: 'open',
      title: 'PR #1',
      created_at: t1,
      updated_at: t1,
      mergeable_state: 'clean',
      node_id: '12345',
    };

    const pr2: GhRestPr = {
      ...pr1,
      number: 2,
      head: {
        ref: 'branch-2',
        sha: '222' as LongCommitSha,
        repo: { full_name: 'some/repo' },
      },
      state: 'open',
      title: 'PR #2',
      updated_at: t2,
    };

    const pr3: GhRestPr = {
      ...pr1,
      number: 3,
      head: {
        ref: 'branch-3',
        sha: '333' as LongCommitSha,
        repo: { full_name: 'some/repo' },
      },
      state: 'open',
      title: 'PR #3',
      updated_at: t3,
    };

    const pagePath = (x: number, perPage = 100) =>
      `/repos/some/repo/pulls?per_page=${perPage}&state=all&sort=updated&direction=desc&page=${x}`;
    const pageLink = (x: number) =>
      `<${githubApiHost}${pagePath(x)}>; rel="next"`;

    it('fetches single page', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.get(pagePath(1)).reply(200, [pr1]);
      await github.initRepo({ repository: 'some/repo' });

      const res = await github.getPrList();

      expect(res).toMatchObject([{ number: 1, title: 'PR #1' }]);
    });

    it('fetches multiple pages', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(pagePath(1))
        .reply(200, [pr3], {
          link: `${pageLink(2)}, ${pageLink(3).replace('next', 'last')}`,
        })
        .get(pagePath(2))
        .reply(200, [pr2], { link: pageLink(3) })
        .get(pagePath(3))
        .reply(200, [pr1]);
      await github.initRepo({ repository: 'some/repo' });

      const res = await github.getPrList();

      expect(res).toMatchObject([{ number: 3 }, { number: 2 }, { number: 1 }]);
    });

    it('synchronizes cache', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      initRepoMock(scope, 'some/repo');

      scope
        .get(pagePath(1))
        .reply(200, [pr3], {
          link: `${pageLink(2)}, ${pageLink(3).replace('next', 'last')}`,
        })
        .get(pagePath(2))
        .reply(200, [pr2])
        .get(pagePath(3))
        .reply(200, [pr1]);

      await github.initRepo({ repository: 'some/repo' });
      const res1 = await github.getPrList();

      scope
        .get(pagePath(1, 20))
        .reply(200, [{ ...pr3, updated_at: t4, title: 'PR #3 (updated)' }], {
          link: `${pageLink(2)}`,
        })
        .get(pagePath(2, 20))
        .reply(200, [{ ...pr2, updated_at: t4, title: 'PR #2 (updated)' }], {
          link: `${pageLink(3)}`,
        })
        .get(pagePath(3, 20))
        .reply(200, [{ ...pr1, updated_at: t4, title: 'PR #1 (updated)' }]);

      await github.initRepo({ repository: 'some/repo' });
      const res2 = await github.getPrList();

      expect(res1).toMatchObject([
        { number: 3, title: 'PR #3' },
        { number: 2, title: 'PR #2' },
        { number: 1, title: 'PR #1' },
      ]);
      expect(res2).toMatchObject([
        { number: 3, title: 'PR #3 (updated)' },
        { number: 2, title: 'PR #2 (updated)' },
        { number: 1, title: 'PR #1 (updated)' },
      ]);
    });

    describe('Body compaction', () => {
      type PrCache = ApiPageCache<GhRestPr>;

      const prWithBody = (body: string): GhRestPr => ({
        ...pr1,
        body,
      });

      it('compacts body from response', async () => {
        const scope = httpMock.scope(githubApiHost);
        initRepoMock(scope, 'some/repo');
        scope.get(pagePath(1)).reply(200, [prWithBody('foo')]);
        await github.initRepo({ repository: 'some/repo' });

        await github.getPrList();

        const repoCache = repository.getCache();
        const pullRequestsCache = repoCache.platform?.github
          ?.pullRequestsCache as PrCache;
        expect(pullRequestsCache).toMatchObject({ items: {} });

        const item = pullRequestsCache.items[1];
        expect(item).toBeDefined();
        expect(item.body).toBeUndefined();
        expect(item.bodyStruct).toEqual({ hash: hashBody('foo') });
      });
    });

    describe('PR author filtering', () => {
      const renovatePr: GhRestPr = {
        ...pr1,
        number: 1,
        head: {
          ref: 'renovate-branch',
          sha: '111' as LongCommitSha,
          repo: { full_name: 'some/repo' },
        },
        title: 'Renovate PR',
        user: { login: 'renovate-bot' },
      };

      const otherPr: GhRestPr = {
        ...pr1,
        number: 2,
        head: {
          ref: 'other-branch',
          sha: '222' as LongCommitSha,
          repo: { full_name: 'some/repo' },
        },
        title: 'Other PR',
        user: { login: 'other-user' },
      };

      it('filters PRs by renovate username when no forkToken or ignorePrAuthor', async () => {
        const scope = httpMock.scope(githubApiHost);
        initRepoMock(scope, 'some/repo');
        scope.get(pagePath(1)).reply(200, [renovatePr, otherPr]);
        await github.initRepo({
          repository: 'some/repo',
          renovateUsername: 'renovate-bot',
        });

        const res = await github.getPrList();

        expect(res).toHaveLength(1);
        expect(res).toMatchObject([{ number: 1, title: 'Renovate PR' }]);
      });

      it('fetches all PRs when forkToken is set', async () => {
        const scope = httpMock.scope(githubApiHost);
        forkInitRepoMock(scope, 'some/repo', false);
        scope.get('/user').reply(200, {
          login: 'forked',
        });
        scope.post('/repos/some/repo/forks').reply(200, {
          full_name: 'forked/repo',
          default_branch: 'master',
        });
        scope.get(pagePath(1)).reply(200, [renovatePr, otherPr]);
        await github.initRepo({
          repository: 'some/repo',
          renovateUsername: 'renovate-bot',
          forkToken: 'some-token',
          forkCreation: true,
        });

        const res = await github.getPrList();

        expect(res).toHaveLength(2);
        expect(res).toMatchObject([
          { number: 2, title: 'Other PR' },
          { number: 1, title: 'Renovate PR' },
        ]);
      });

      it('fetches all PRs when ignorePrAuthor is set', async () => {
        const scope = httpMock.scope(githubApiHost);
        initRepoMock(scope, 'some/repo');
        scope.get(pagePath(1)).reply(200, [renovatePr, otherPr]);
        await github.initRepo({
          repository: 'some/repo',
          renovateUsername: 'renovate-bot',
          ignorePrAuthor: true,
        });

        const res = await github.getPrList();

        expect(res).toHaveLength(2);
        expect(res).toMatchObject([
          { number: 2, title: 'Other PR' },
          { number: 1, title: 'Renovate PR' },
        ]);
      });
    });
  });

  describe('getBranchPr(branchName)', () => {
    beforeEach(() => {
      GlobalConfig.reset();
    });

    it('should return null if no PR exists', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, []);

      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.getBranchPr('somebranch');
      expect(pr).toBeNull();
    });

    it('should cache and return the PR object', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 90,
            head: { ref: 'somebranch', repo: { full_name: 'other/repo' } },
            state: 'open',
            title: 'PR from another repo',
            updated_at: '01-09-2022',
          },
          {
            number: 91,
            base: { sha: '1234' },
            head: { ref: 'somebranch', repo: { full_name: 'some/repo' } },
            state: 'open',
            title: 'Some title',
            updated_at: '01-09-2022',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      const pr = await github.getBranchPr('somebranch');
      const pr2 = await github.getBranchPr('somebranch');

      expect(pr).toMatchObject({ number: 91, sourceBranch: 'somebranch' });
      expect(pr2).toEqual(pr);
    });
  });

  describe('tryReuseAutoclosedPr()', () => {
    it('should reopen autoclosed PR', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .head('/repos/some/repo/git/commits/1234')
        .reply(200)
        .post('/repos/some/repo/git/refs')
        .reply(201)
        .patch('/repos/some/repo/pulls/91')
        .reply(200, {
          number: 91,
          base: { sha: '1234' },
          head: { ref: 'somebranch', repo: { full_name: 'some/repo' } },
          state: 'open',
          title: 'old title',
          updated_at: '01-09-2022',
        });
      await github.initRepo({ repository: 'some/repo' });
      vi.spyOn(branch, 'remoteBranchExists').mockResolvedValueOnce(false);

      const pr = await github.tryReuseAutoclosedPr({
        number: 91,
        title: 'old title - autoclosed',
        state: 'closed',
        closedAt: DateTime.now().minus({ days: 6 }).toISO(),
        sourceBranch: 'somebranch',
        sha: '1234' as LongCommitSha,
      });

      expect(pr).toMatchObject({ number: 91, sourceBranch: 'somebranch' });
    });

    it('aborts reopening if branch recreation fails', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .head('/repos/some/repo/git/commits/1234')
        .reply(200)
        .post('/repos/some/repo/git/refs')
        .reply(201)
        .patch('/repos/some/repo/pulls/91')
        .reply(422);
      vi.spyOn(branch, 'remoteBranchExists').mockResolvedValueOnce(false);

      await github.initRepo({ repository: 'some/repo' });

      const pr = await github.tryReuseAutoclosedPr({
        number: 91,
        title: 'old title - autoclosed',
        state: 'closed',
        closedAt: DateTime.now().minus({ days: 6 }).toISO(),
        sourceBranch: 'somebranch',
        sha: '1234' as LongCommitSha,
      });

      expect(pr).toBeNull();
    });

    it('aborts reopening if PR reopening fails', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.head('/repos/some/repo/git/commits/1234').reply(400);

      await github.initRepo({ repository: 'some/repo' });

      const pr = await github.tryReuseAutoclosedPr({
        number: 91,
        title: 'old title - autoclosed',
        state: 'closed',
        closedAt: DateTime.now().minus({ days: 6 }).toISO(),
        sourceBranch: 'somebranch',
        sha: '1234' as LongCommitSha,
      });

      expect(pr).toBeNull();
    });
  });

  describe('getBranchStatus()', () => {
    it('should pass through success', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/commits/somebranch/status')
        .reply(200, {
          state: 'success',
        })
        .get('/repos/some/repo/commits/somebranch/check-runs?per_page=100')
        .reply(200, []);

      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatus('somebranch', true);
      expect(res).toBe('green');
    });

    it('should not consider internal statuses as success', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/commits/somebranch/status')
        .reply(200, {
          state: 'success',
          statuses: [
            {
              context: 'renovate/stability-days',
              state: 'success',
            },
          ],
        })
        .get('/repos/some/repo/commits/somebranch/check-runs?per_page=100')
        .reply(200, []);

      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatus('somebranch', false);
      expect(res).toBe('yellow');
    });

    it('should pass through failed', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/commits/somebranch/status')
        .reply(200, {
          state: 'failure',
        })
        .get('/repos/some/repo/commits/somebranch/check-runs?per_page=100')
        .reply(200, []);

      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatus('somebranch', true);
      expect(res).toBe('red');
    });

    it('defaults to pending', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/commits/somebranch/status')
        .reply(200, {
          state: 'unknown',
        })
        .get('/repos/some/repo/commits/somebranch/check-runs?per_page=100')
        .reply(200, []);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatus('somebranch', true);
      expect(res).toBe('yellow');
    });

    it('should fail if a check run has failed', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/commits/somebranch/status')
        .reply(200, {
          state: 'pending',
          statuses: [],
        })
        .get('/repos/some/repo/commits/somebranch/check-runs?per_page=100')
        .reply(200, {
          total_count: 2,
          check_runs: [
            {
              id: 23950198,
              status: 'completed',
              conclusion: 'success',
              name: 'Travis CI - Pull Request',
            },
            {
              id: 23950195,
              status: 'completed',
              conclusion: 'failure',
              name: 'Travis CI - Branch',
            },
          ],
        });
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatus('somebranch', true);
      expect(res).toBe('red');
    });

    it('should succeed if no status and all passed check runs', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/commits/somebranch/status')
        .reply(200, {
          state: 'pending',
          statuses: [],
        })
        .get('/repos/some/repo/commits/somebranch/check-runs?per_page=100')
        .reply(200, {
          total_count: 3,
          check_runs: [
            {
              id: 2390199,
              status: 'completed',
              conclusion: 'skipped',
              name: 'Conditional GitHub Action',
            },
            {
              id: 23950198,
              status: 'completed',
              conclusion: 'success',
              name: 'Travis CI - Pull Request',
            },
            {
              id: 23950195,
              status: 'completed',
              conclusion: 'success',
              name: 'Travis CI - Branch',
            },
          ],
        });
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatus('somebranch', true);
      expect(res).toBe('green');
    });

    it('should fail if a check run is pending', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/commits/somebranch/status')
        .reply(200, {
          state: 'pending',
          statuses: [],
        })
        .get('/repos/some/repo/commits/somebranch/check-runs?per_page=100')
        .reply(200, {
          total_count: 2,
          check_runs: [
            {
              id: 23950198,
              status: 'completed',
              conclusion: 'success',
              name: 'Travis CI - Pull Request',
            },
            {
              id: 23950195,
              status: 'pending',
              name: 'Travis CI - Branch',
            },
          ],
        });
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatus('somebranch', true);
      expect(res).toBe('yellow');
    });
  });

  describe('getBranchStatusCheck', () => {
    it('returns state if found', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses',
        )
        .reply(200, [
          {
            context: 'context-1',
            state: 'success',
          },
          {
            context: 'context-2',
            state: 'pending',
          },
          {
            context: 'context-3',
            state: 'failure',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatusCheck(
        'renovate/future_branch',
        'context-2',
      );
      expect(res).toBe('yellow');
    });

    it('returns null', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses',
        )
        .reply(200, [
          {
            context: 'context-1',
            state: 'success',
          },
          {
            context: 'context-2',
            state: 'pending',
          },
          {
            context: 'context-3',
            state: 'error',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatusCheck('somebranch', 'context-4');
      expect(res).toBeNull();
    });

    it('returns yellow if state not present in context object', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses',
        )
        .reply(200, [
          {
            context: 'context-1',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getBranchStatusCheck('somebranch', 'context-1');
      expect(res).toBe('yellow');
    });
  });

  describe('setBranchStatus', () => {
    it('returns if already set', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses',
        )
        .reply(200, [
          {
            context: 'some-context',
            state: 'pending',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      await expect(
        github.setBranchStatus({
          branchName: 'some-branch',
          context: 'some-context',
          description: 'some-description',
          state: 'yellow',
          url: 'some-url',
        }),
      ).toResolve();
    });

    it('sets branch status', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses',
        )
        .reply(200, [
          {
            context: 'context-1',
            state: 'state-1',
          },
          {
            context: 'context-2',
            state: 'state-2',
          },
          {
            context: 'context-3',
            state: 'state-3',
          },
        ])
        .post(
          '/repos/some/repo/statuses/0d9c7726c3d628b7e28af234595cfd20febdbf8e',
        )
        .reply(200)
        .get('/repos/some/repo/commits/some-branch/status')
        .reply(200, {})
        .get(
          '/repos/some/repo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses',
        )
        .reply(200, {});

      await github.initRepo({ repository: 'some/repo' });
      await expect(
        github.setBranchStatus({
          branchName: 'some-branch',
          context: 'some-context',
          description: 'some-description',
          state: 'green',
          url: 'some-url',
        }),
      ).toResolve();
    });
  });

  describe('getIssue()', () => {
    it('returns null if issues disabled', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo', { hasIssuesEnabled: false });
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getIssue(1);
      expect(res).toBeNull();
    });

    it('returns issue', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      const issue = {
        number: 1,
        state: 'open',
        title: 'title-1',
        body: 'body-1',
      };
      scope
        .get('/repos/some/repo/issues/1')
        .reply(200, { ...issue, updated_at: '2022-01-01T00:00:00Z' });
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getIssue(1);
      expect(res).toMatchObject({
        ...issue,
        lastModified: '2022-01-01T00:00:00Z',
      });
    });

    it('returns null if issue not found', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.get('/repos/some/repo/issues/1').reply(404);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getIssue(1);
      expect(res).toBeNull();
    });

    it('logs debug message if issue deleted', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.get('/repos/some/repo/issues/1').reply(410);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getIssue(1);
      expect(res).toBeNull();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        'Issue #1 has been deleted',
      );
    });
  });

  describe('findIssue()', () => {
    it('returns null if no issue', async () => {
      httpMock
        .scope(githubApiHost)
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        });
      const res = await github.findIssue('title-3');
      expect(res).toBeNull();
    });

    it('finds issue', async () => {
      httpMock
        .scope(githubApiHost)
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/undefined/issues/2')
        .reply(200, {
          number: 2,
          state: 'open',
          title: 'title-2',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      const res = await github.findIssue('title-2');
      expect(res).toEqual({
        number: 2,
        state: 'open',
        title: 'title-2',
        body: 'new-content',
        lastModified: '2023-01-01T00:00:00Z',
      });
    });
  });

  describe('ensureIssue()', () => {
    it('creates issue', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .post('/repos/some/repo/issues')
        .reply(200, {
          number: 3,
          state: 'open',
          title: 'new-title',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      const res = await github.ensureIssue({
        title: 'new-title',
        body: 'new-content',
      });
      expect(res).toBe('created');
    });

    it('creates issue if not ensuring only once', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'closed',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/some/repo/issues/1')
        .reply(404);
      const res = await github.ensureIssue({
        title: 'title-1',
        body: 'new-content',
      });
      expect(res).toBeNull();
    });

    it('does not create issue if ensuring only once', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.post('/graphql').reply(200, {
        data: {
          repository: {
            issues: {
              pageInfo: {
                startCursor: null,
                hasNextPage: false,
                endCursor: null,
              },
              nodes: [
                {
                  number: 2,
                  state: 'open',
                  title: 'title-2',
                  body: 'body-2',
                  updatedAt: '2022-01-01T00:00:00Z',
                },
                {
                  number: 1,
                  state: 'closed',
                  title: 'title-1',
                  body: 'body-1',
                  updatedAt: '2021-01-01T00:00:00Z',
                },
              ],
            },
          },
        },
      });
      const once = true;
      const res = await github.ensureIssue({
        title: 'title-1',
        body: 'new-content',
        once,
      });
      expect(res).toBeNull();
    });

    it('creates issue with labels', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        })
        .post('/repos/some/repo/issues')
        .reply(200, {
          number: 3,
          state: 'open',
          title: 'new-title',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      const res = await github.ensureIssue({
        title: 'new-title',
        body: 'new-content',
        labels: ['Renovate', 'Maintenance'],
      });
      expect(res).toBe('created');
    });

    it('closes others if ensuring only once', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 3,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'closed',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/some/repo/issues/3')
        .reply(404);
      const once = true;
      const res = await github.ensureIssue({
        title: 'title-1',
        body: 'new-content',
        once,
      });
      expect(res).toBeNull();
    });

    it('updates issue', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/some/repo/issues/2')
        .reply(200, {
          number: 2,
          state: 'open',
          title: 'title-2',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        })
        .patch('/repos/some/repo/issues/2')
        .reply(200, {
          number: 2,
          state: 'open',
          title: 'title-2',
          body: 'newer-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      const res = await github.ensureIssue({
        title: 'title-3',
        reuseTitle: 'title-2',
        body: 'newer-content',
      });
      expect(res).toBe('updated');
    });

    it('updates issue with labels', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/some/repo/issues/2')
        .reply(200, {
          number: 2,
          state: 'open',
          title: 'title-2',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        })
        .patch('/repos/some/repo/issues/2')
        .reply(200, {
          number: 2,
          state: 'open',
          title: 'title-2',
          body: 'newer-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      const res = await github.ensureIssue({
        title: 'title-3',
        reuseTitle: 'title-2',
        body: 'newer-content',
        labels: ['Renovate', 'Maintenance'],
      });
      expect(res).toBe('updated');
    });

    it('skips update if unchanged', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'newer-content',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'new-content',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/some/repo/issues/2')
        .reply(200, { body: 'newer-content' });
      const res = await github.ensureIssue({
        title: 'title-2',
        body: 'newer-content',
      });
      expect(res).toBeNull();
    });

    it('deletes if duplicate', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .patch('/repos/some/repo/issues/1')
        .reply(200);
      const res = await github.ensureIssue({
        title: 'title-1',
        body: 'newer-content',
      });
      expect(res).toBeNull();
    });

    it('creates issue if reopen flag false and issue is not open', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'close',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/some/repo/issues/2')
        .reply(200, {
          number: 2,
          state: 'closed',
          title: 'title-2',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        })
        .post('/repos/some/repo/issues')
        .reply(200, {
          number: 3,
          state: 'open',
          title: 'title-2',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      const res = await github.ensureIssue({
        title: 'title-2',
        body: 'new-content',
        once: false,
        shouldReOpen: false,
      });
      expect(res).toBe('created');
    });

    it('does not create issue if reopen flag false and issue is already open', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .get('/repos/some/repo/issues/2')
        .reply(200, {
          number: 2,
          state: 'open',
          title: 'title-2',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      const res = await github.ensureIssue({
        title: 'title-2',
        body: 'new-content',
        once: false,
        shouldReOpen: false,
      });
      expect(res).toBeNull();
    });
  });

  describe('ensureIssueClosing()', () => {
    it('closes issue', async () => {
      httpMock
        .scope(githubApiHost)
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              issues: {
                pageInfo: {
                  startCursor: null,
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    number: 2,
                    state: 'open',
                    title: 'title-2',
                    body: 'body-2',
                    updatedAt: '2022-01-01T00:00:00Z',
                  },
                  {
                    number: 1,
                    state: 'open',
                    title: 'title-1',
                    body: 'body-1',
                    updatedAt: '2021-01-01T00:00:00Z',
                  },
                ],
              },
            },
          },
        })
        .patch('/repos/undefined/issues/2')
        .reply(200, {
          number: 2,
          state: 'closed',
          title: 'title-2',
          body: 'new-content',
          updated_at: '2023-01-01T00:00:00Z',
        });
      await expect(github.ensureIssueClosing('title-2')).toResolve();
    });
  });

  describe('deleteLabel(issueNo, label)', () => {
    it('should delete the label', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.delete('/repos/some/repo/issues/42/labels/rebase').reply(200);
      await github.initRepo({ repository: 'some/repo' });
      await expect(github.deleteLabel(42, 'rebase')).toResolve();
    });
  });

  describe('addAssignees(issueNo, assignees)', () => {
    it('should add the given assignees to the issue', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.post('/repos/some/repo/issues/42/assignees').reply(200, {
        number: 42,
        state: 'open',
        title: 'title-42',
        body: 'body-42',
        updated_at: '2023-01-01T00:00:00Z',
      });
      await github.initRepo({ repository: 'some/repo' });
      await expect(
        github.addAssignees(42, ['someuser', 'someotheruser']),
      ).toResolve();
    });
  });

  describe('addReviewers(issueNo, reviewers)', () => {
    it('should add the given reviewers to the PR', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.post('/repos/some/repo/pulls/42/requested_reviewers').reply(200);
      await github.initRepo({ repository: 'some/repo' });
      await expect(
        github.addReviewers(42, ['someuser', 'someotheruser', 'team:someteam']),
      ).toResolve();
    });
  });

  describe('ensureComment', () => {
    it('add comment if not found', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/issues/42/comments?per_page=100')
        .reply(200, [])
        .post('/repos/some/repo/issues/42/comments')
        .reply(200);
      await github.initRepo({ repository: 'some/repo' });

      await expect(
        github.ensureComment({
          number: 42,
          topic: 'some-subject',
          content: 'some\ncontent',
        }),
      ).toResolve();
    });

    it('adds comment if found in closed PR list', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/issues/2499/comments?per_page=100')
        .reply(200, [
          {
            id: 419928791,
            body: '[![CLA assistant check](https://cla-assistant.io/pull/badge/signed)](https://cla-assistant.io/renovatebot/renovate?pullRequest=2500) <br/>All committers have signed the CLA.',
          },
          {
            id: 420006957,
            body: ':tada: This PR is included in version 13.63.5 :tada:\n\nThe release is available on:\n- [npm package (@latest dist-tag)](https://www.npmjs.com/package/renovate)\n- [GitHub release](https://github.com/renovatebot/renovate/releases/tag/13.63.5)\n\nYour **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:',
          },
        ])
        .post('/repos/some/repo/issues/2499/comments')
        .reply(200);
      await github.initRepo({ repository: 'some/repo' });

      await expect(
        github.ensureComment({
          number: 2499,
          topic: 'some-subject',
          content: 'some\ncontent',
        }),
      ).toResolve();
    });

    it('add updates comment if necessary', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/issues/42/comments?per_page=100')
        .reply(200, [{ id: 1234, body: '### some-subject\n\nblablabla' }])
        .patch('/repos/some/repo/issues/comments/1234')
        .reply(200);
      await github.initRepo({ repository: 'some/repo' });

      await expect(
        github.ensureComment({
          number: 42,
          topic: 'some-subject',
          content: 'some\ncontent',
        }),
      ).toResolve();
    });

    it('skips comment', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/issues/42/comments?per_page=100')
        .reply(200, [{ id: 1234, body: '### some-subject\n\nsome\ncontent' }]);
      await github.initRepo({ repository: 'some/repo' });

      await expect(
        github.ensureComment({
          number: 42,
          topic: 'some-subject',
          content: 'some\ncontent',
        }),
      ).toResolve();
    });

    it('handles comment with no description', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/issues/42/comments?per_page=100')
        .reply(200, [{ id: 1234, body: '!merge' }]);
      await github.initRepo({ repository: 'some/repo' });

      await expect(
        github.ensureComment({
          number: 42,
          topic: null,
          content: '!merge',
        }),
      ).toResolve();
    });
  });

  describe('ensureCommentRemoval', () => {
    it('deletes comment by topic if found', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/issues/42/comments?per_page=100')
        .reply(200, [{ id: 1234, body: '### some-subject\n\nblablabla' }])
        .delete('/repos/some/repo/issues/comments/1234')
        .reply(200);
      await github.initRepo({ repository: 'some/repo' });

      await expect(
        github.ensureCommentRemoval({
          type: 'by-topic',
          number: 42,
          topic: 'some-subject',
        }),
      ).toResolve();
    });

    it('deletes comment by content if found', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/issues/42/comments?per_page=100')
        .reply(200, [{ id: 1234, body: 'some-content' }])
        .delete('/repos/some/repo/issues/comments/1234')
        .reply(200);
      await github.initRepo({ repository: 'some/repo' });

      await expect(
        github.ensureCommentRemoval({
          type: 'by-content',
          number: 42,
          content: 'some-content',
        }),
      ).toResolve();
    });
  });

  describe('findPr(branchName, prTitle, state)', () => {
    it('finds PR by branch name', async () => {
      const scope = httpMock
        .scope(githubApiHost)
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 2,
            head: {
              ref: 'branch-a',
              repo: { full_name: 'some/repo' },
            },
            title: 'branch a pr',
            state: 'open',
            user: { login: 'not-me' },
          },
          {
            number: 1,
            head: {
              ref: 'branch-a',
              repo: { full_name: 'some/repo' },
            },
            title: 'branch a pr',
            state: 'open',
            user: { login: 'me' },
          },
        ]);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({
        repository: 'some/repo',
        renovateUsername: 'me',
      });

      const res = await github.findPr({ branchName: 'branch-a' });

      expect(res).toMatchObject({
        number: 1,
        sourceBranch: 'branch-a',
      });
    });

    it('finds PR with non-open state', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 1,
            head: { ref: 'branch-a', repo: { full_name: 'some/repo' } },
            title: 'branch a pr',
            state: 'closed',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      const res = await github.findPr({
        branchName: 'branch-a',
        state: '!open',
      });

      expect(res).toMatchObject({
        number: 1,
        sourceBranch: 'branch-a',
        state: 'closed',
      });
    });

    it('skips PR with non-matching state', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 1,
            head: { ref: 'branch-a', repo: { full_name: 'some/repo' } },
            title: 'branch a pr',
            state: 'closed',
            closed_at: DateTime.now().minus({ days: 1 }).toISO(),
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      const res = await github.findPr({
        branchName: 'branch-a',
        state: 'open',
      });

      expect(res).toBeNull();
    });

    it('skips PRs from forks', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 1,
            head: { ref: 'branch-a', repo: { full_name: 'other/repo' } },
            title: 'branch a pr',
            state: 'open',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      const res = await github.findPr({
        branchName: 'branch-a',
        state: 'open',
      });

      expect(res).toBeNull();
    });

    it('skips PR with non-matching title', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 1,
            head: { ref: 'branch-a', repo: { full_name: 'some/repo' } },
            title: 'foo',
            state: 'closed',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      const res = await github.findPr({
        branchName: 'branch-a',
        prTitle: 'bar',
      });

      expect(res).toBeNull();
    });

    it('caches pr list', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 1,
            head: { ref: 'branch-a', repo: { full_name: 'some/repo' } },
            title: 'branch a pr',
            state: 'open',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      let res = await github.findPr({ branchName: 'branch-a' });

      expect(res).toBeDefined();
      res = await github.findPr({
        branchName: 'branch-a',
        prTitle: 'branch a pr',
      });
      expect(res).toBeDefined();
      res = await github.findPr({
        branchName: 'branch-a',
        prTitle: 'branch a pr',
        state: 'open',
      });
      expect(res).toBeDefined();
      res = await github.findPr({ branchName: 'branch-b' });
      expect(res).toBeNull();
    });

    it('finds pr from other authors', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/pulls?head=some:branch&state=open')
        .reply(200, [
          {
            number: 1,
            head: { ref: 'branch-a', repo: { full_name: 'some/repo' } },
            title: 'branch a pr',
            state: 'open',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      expect(
        await github.findPr({
          branchName: 'branch',
          state: 'open',
          includeOtherAuthors: true,
        }),
      ).toMatchObject({
        number: 1,
        sourceBranch: 'branch-a',
        sourceRepo: 'some/repo',
        state: 'open',
        title: 'branch a pr',
        updated_at: undefined,
      });
    });

    it('returns null if no pr found - (includeOtherAuthors)', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get('/repos/some/repo/pulls?head=some:branch&state=open')
        .reply(200, []);
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.findPr({
        branchName: 'branch',
        state: 'open',
        includeOtherAuthors: true,
      });
      expect(pr).toBeNull();
    });
  });

  describe('createPr()', () => {
    it('should create and return a PR object', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .post('/repos/some/repo/pulls')
        .reply(200, {
          number: 123,
          head: { repo: { full_name: 'some/repo' } },
        })
        .post('/repos/some/repo/issues/123/labels')
        .reply(200, []);
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'dev',
        prTitle: 'The Title',
        prBody: 'Hello world',
        labels: ['deps', 'renovate'],
      });
      expect(pr).toMatchObject({ number: 123 });
    });

    it('should use defaultBranch', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.post('/repos/some/repo/pulls').reply(200, {
        number: 123,
        head: { repo: { full_name: 'some/repo' } },
      });
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'The Title',
        prBody: 'Hello world',
        labels: null,
      });
      expect(pr).toMatchObject({ number: 123 });
    });

    it('should create a draftPR if set in the settings', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.post('/repos/some/repo/pulls').reply(200, {
        number: 123,
        head: { repo: { full_name: 'some/repo' }, ref: 'some-branch' },
      });
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'PR draft',
        prBody: 'This is a result of a draft',
        labels: null,
        draftPR: true,
      });
      expect(pr).toMatchObject({ number: 123 });
    });

    describe('with forkToken', () => {
      let scope: httpMock.Scope;

      beforeEach(async () => {
        scope = httpMock.scope(githubApiHost);
        forkInitRepoMock(scope, 'some/repo', false);
        scope.get('/user').reply(200, {
          login: 'forked',
        });
        scope.post('/repos/some/repo/forks').reply(200, {
          full_name: 'forked/repo',
          default_branch: 'master',
        });

        await github.initRepo({
          repository: 'some/repo',
          forkToken: 'true',
          forkCreation: true,
        });
      });

      it('should allow maintainer edits if explicitly enabled via options', async () => {
        scope
          .post(
            '/repos/some/repo/pulls',
            // Ensure the `maintainer_can_modify` option is set in the REST API request.
            (body) => body.maintainer_can_modify === true,
          )
          .reply(200, {
            number: 123,
            head: { repo: { full_name: 'some/repo' }, ref: 'some-branch' },
          });
        const pr = await github.createPr({
          sourceBranch: 'some-branch',
          targetBranch: 'main',
          prTitle: 'PR title',
          prBody: 'PR can be edited by maintainers.',
          labels: null,
          platformPrOptions: {
            forkModeDisallowMaintainerEdits: false,
          },
        });
        expect(pr).toMatchObject({ number: 123 });
      });

      it('should allow maintainer edits if not explicitly set', async () => {
        scope
          .post(
            '/repos/some/repo/pulls',
            // Ensure the `maintainer_can_modify` option is `false` in the REST API request.
            (body) => body.maintainer_can_modify === true,
          )
          .reply(200, {
            number: 123,
            head: { repo: { full_name: 'some/repo' }, ref: 'some-branch' },
          });
        const pr = await github.createPr({
          sourceBranch: 'some-branch',
          targetBranch: 'main',
          prTitle: 'PR title',
          prBody: 'PR *cannot* be edited by maintainers.',
          labels: null,
        });
        expect(pr).toMatchObject({ number: 123 });
      });

      it('should disallow maintainer edits if explicitly disabled', async () => {
        scope
          .post(
            '/repos/some/repo/pulls',
            // Ensure the `maintainer_can_modify` option is `false` in the REST API request.
            (body) => body.maintainer_can_modify === false,
          )
          .reply(200, {
            number: 123,
            head: { repo: { full_name: 'some/repo' }, ref: 'some-branch' },
          });
        const pr = await github.createPr({
          sourceBranch: 'some-branch',
          targetBranch: 'main',
          prTitle: 'PR title',
          prBody: 'PR *cannot* be edited by maintainers.',
          labels: null,
          platformPrOptions: {
            forkModeDisallowMaintainerEdits: true,
          },
        });
        expect(pr).toMatchObject({ number: 123 });
      });
    });

    describe('automerge', () => {
      const createdPrResp = {
        number: 123,
        node_id: 'abcd',
        head: { repo: { full_name: 'some/repo' } },
      };

      const graphqlAutomergeResp = {
        data: {
          enablePullRequestAutoMerge: {
            pullRequest: {
              number: 123,
            },
          },
        },
      };

      const graphqlAutomergeErrorResp = {
        ...graphqlAutomergeResp,
        errors: [
          {
            type: 'UNPROCESSABLE',
            message:
              'Pull request is not in the correct state to enable auto-merge',
          },
        ],
      };

      const prConfig: CreatePRConfig = {
        sourceBranch: 'some-branch',
        targetBranch: 'dev',
        prTitle: 'The Title',
        prBody: 'Hello world',
        labels: ['deps', 'renovate'],
        platformPrOptions: { usePlatformAutomerge: true },
      };

      const mockScope = async (repoOpts: any = {}): Promise<httpMock.Scope> => {
        const scope = httpMock.scope(githubApiHost);
        initRepoMock(scope, 'some/repo', repoOpts);
        scope
          .post('/repos/some/repo/pulls')
          .reply(200, createdPrResp)
          .post('/repos/some/repo/issues/123/labels')
          .reply(200, []);
        await github.initRepo({ repository: 'some/repo' });
        return scope;
      };

      const graphqlGetRepo = {
        method: 'POST',
        url: 'https://api.github.com/graphql',
        graphql: { query: { repository: {} } },
      };

      const restCreatePr = {
        method: 'POST',
        url: 'https://api.github.com/repos/some/repo/pulls',
      };

      const restAddLabels = {
        method: 'POST',
        url: 'https://api.github.com/repos/some/repo/issues/123/labels',
      };

      const graphqlAutomerge = {
        method: 'POST',
        url: 'https://api.github.com/graphql',
        graphql: {
          mutation: {
            __vars: {
              $pullRequestId: 'ID!',
              $mergeMethod: 'PullRequestMergeMethod!',
            },
            enablePullRequestAutoMerge: {
              __args: {
                input: {
                  pullRequestId: '$pullRequestId',
                  mergeMethod: '$mergeMethod',
                },
              },
            },
          },
          variables: {
            pullRequestId: 'abcd',
            mergeMethod: 'SQUASH',
          },
        },
      };

      it('should skip automerge if disabled in repo settings', async () => {
        await mockScope({ autoMergeAllowed: false });

        const pr = await github.createPr(prConfig);

        expect(pr).toMatchObject({ number: 123 });
        expect(httpMock.getTrace()).toMatchObject([
          graphqlGetRepo,
          restCreatePr,
          restAddLabels,
        ]);
      });

      it('should skip automerge if GHE <3.3.0', async () => {
        const scope = httpMock
          .scope('https://github.company.com')
          .head('/')
          .reply(200, '', { 'x-github-enterprise-version': '3.1.7' })
          .get('/user')
          .reply(200, {
            login: 'renovate-bot',
          })
          .get('/user/emails')
          .reply(200, {})
          .post('/repos/some/repo/pulls')
          .reply(200, {
            number: 123,
          })
          .post('/repos/some/repo/issues/123/labels')
          .reply(200, []);

        initRepoMock(scope, 'some/repo');
        await github.initPlatform({
          endpoint: 'https://github.company.com',
          token: '123test',
        });
        hostRules.find.mockReturnValue({
          token: '123test',
        });
        await github.initRepo({ repository: 'some/repo' });
        await github.createPr(prConfig);

        expect(logger.logger.debug).toHaveBeenCalledWith(
          { prNumber: 123 },
          'GitHub-native automerge: not supported on this version of GHE. Use 3.3.0 or newer.',
        );
      });

      it('should perform automerge if GHE >=3.3.0', async () => {
        const scope = httpMock
          .scope('https://github.company.com')
          .head('/')
          .reply(200, '', { 'x-github-enterprise-version': '3.3.5' })
          .get('/user')
          .reply(200, {
            login: 'renovate-bot',
          })
          .get('/user/emails')
          .reply(200, {})
          .post('/repos/some/repo/pulls')
          .reply(200, {
            number: 123,
          })
          .post('/repos/some/repo/issues/123/labels')
          .reply(200, [])
          .post('/graphql')
          .reply(200, {
            data: {
              repository: {
                defaultBranchRef: {
                  name: 'main',
                },
                nameWithOwner: 'some/repo',
                autoMergeAllowed: true,
              },
            },
          });

        initRepoMock(scope, 'some/repo');
        await github.initPlatform({
          endpoint: 'https://github.company.com',
          token: '123test',
        });
        hostRules.find.mockReturnValue({
          token: '123test',
        });
        await github.initRepo({ repository: 'some/repo' });
        await github.createPr(prConfig);

        expect(logger.logger.debug).toHaveBeenCalledWith(
          'GitHub-native automerge: success...PrNo: 123',
        );
      });

      it('should set automatic merge', async () => {
        const scope = await mockScope();
        scope.post('/graphql').reply(200, graphqlAutomergeResp);

        const pr = await github.createPr(prConfig);

        expect(pr).toMatchObject({ number: 123 });
        expect(httpMock.getTrace()).toMatchObject([
          graphqlGetRepo,
          restCreatePr,
          restAddLabels,
          graphqlAutomerge,
        ]);
      });

      it('should handle GraphQL errors', async () => {
        const scope = await mockScope();
        scope.post('/graphql').reply(200, graphqlAutomergeErrorResp);
        const pr = await github.createPr(prConfig);
        expect(pr).toMatchObject({ number: 123 });
        expect(httpMock.getTrace()).toMatchObject([
          graphqlGetRepo,
          restCreatePr,
          restAddLabels,
          graphqlAutomerge,
        ]);
      });

      it('should handle REST API errors', async () => {
        const scope = await mockScope();
        scope.post('/graphql').reply(500);
        const pr = await github.createPr(prConfig);
        expect(pr).toMatchObject({ number: 123 });
        expect(httpMock.getTrace()).toMatchObject([
          graphqlGetRepo,
          restCreatePr,
          restAddLabels,
          graphqlAutomerge,
        ]);
      });
    });

    describe('milestone', () => {
      it('should set the milestone on the PR', async () => {
        const scope = httpMock.scope(githubApiHost);
        initRepoMock(scope, 'some/repo');
        scope
          .post(
            '/repos/some/repo/pulls',
            (body) => body.title === 'bump someDep to v2',
          )
          .reply(200, {
            number: 123,
            head: { repo: { full_name: 'some/repo' }, ref: 'some-branch' },
          });
        scope
          .patch('/repos/some/repo/issues/123', (body) => body.milestone === 1)
          .reply(200, {
            number: 123,
            state: 'open',
            title: 'bump someDep to v2',
            body: 'many informations about someDep',
            updated_at: '2023-01-01T00:00:00Z',
          });
        await github.initRepo({ repository: 'some/repo' });
        const pr = await github.createPr({
          targetBranch: 'main',
          sourceBranch: 'renovate/someDep-v2',
          prTitle: 'bump someDep to v2',
          prBody: 'many informations about someDep',
          milestone: 1,
        });
        expect(pr?.number).toBe(123);
      });

      it('should log a warning but not throw on error', async () => {
        const scope = httpMock.scope(githubApiHost);
        initRepoMock(scope, 'some/repo');
        scope
          .post(
            '/repos/some/repo/pulls',
            (body) => body.title === 'bump someDep to v2',
          )
          .reply(200, {
            number: 123,
            head: { repo: { full_name: 'some/repo' }, ref: 'some-branch' },
          });
        scope
          .patch('/repos/some/repo/issues/123', (body) => body.milestone === 1)
          .reply(422, {
            message: 'Validation Failed',
            errors: [
              {
                value: 1,
                resource: 'Issue',
                field: 'milestone',
                code: 'invalid',
              },
            ],
            documentation_url:
              'https://docs.github.com/rest/issues/issues#update-an-issue',
          });
        await github.initRepo({ repository: 'some/repo' });
        const pr = await github.createPr({
          targetBranch: 'main',
          sourceBranch: 'renovate/someDep-v2',
          prTitle: 'bump someDep to v2',
          prBody: 'many informations about someDep',
          milestone: 1,
        });
        expect(pr?.number).toBe(123);
        expect(logger.logger.warn).toHaveBeenCalledWith(
          {
            err: {
              message: 'Validation Failed',
              errors: [
                {
                  value: 1,
                  resource: 'Issue',
                  field: 'milestone',
                  code: 'invalid',
                },
              ],
              documentation_url:
                'https://docs.github.com/rest/issues/issues#update-an-issue',
            },
            milestone: 1,
            pr: 123,
          },
          'Unable to add milestone to PR',
        );
      });
    });
  });

  describe('getPr(prNo)', () => {
    it('should return null if no prNo is passed', async () => {
      const pr = await github.getPr(0);
      expect(pr).toBeNull();
    });

    it('should return PR', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 2499,
            head: {
              ref: 'renovate/delay-4.x',
              repo: { full_name: 'some/repo' },
            },
            title: 'build(deps): update dependency delay to v4.0.1',
            state: 'closed',
            updated_at: '01-09-2022',
          },
          {
            number: 2500,
            head: {
              ref: 'renovate/jest-monorepo',
              repo: { full_name: 'some/repo' },
            },
            state: 'open',
            title: 'chore(deps): update dependency jest to v23.6.0',
            updated_at: '01-09-2022',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.getPr(2500);
      expect(pr).toBeDefined();
      expect(pr).toMatchObject({
        number: 2500,
        bodyStruct: { hash: expect.any(String) },
        sourceBranch: 'renovate/jest-monorepo',
        sourceRepo: 'some/repo',
        state: 'open',
        title: 'chore(deps): update dependency jest to v23.6.0',
        updated_at: '01-09-2022',
      });
    });

    it('should return closed PR', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 2500,
            head: {
              ref: 'renovate/jest-monorepo',
              repo: { full_name: 'some/repo' },
            },
            title: 'chore(deps): update dependency jest to v23.6.0',
            state: 'closed',
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      const pr = await github.getPr(2500);

      expect(pr).toMatchObject({ number: 2500, state: 'closed' });
    });

    it('should return merged PR', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 2500,
            head: {
              ref: 'renovate/jest-monorepo',
              repo: { full_name: 'some/repo' },
            },
            title: 'chore(deps): update dependency jest to v23.6.0',
            state: 'closed',
            merged_at: DateTime.now().toISO(),
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });

      const pr = await github.getPr(2500);

      expect(pr).toMatchObject({ number: 2500, state: 'merged' });
    });

    it('should return null if no PR is returned from GitHub', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [])
        .get('/repos/some/repo/pulls/1234')
        .reply(404);
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.getPr(1234);
      expect(pr).toBeNull();
    });

    it(`should return a PR object - 0`, async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [])
        .get('/repos/some/repo/pulls/1234')
        .reply(200, {
          number: 1234,
          state: 'closed',
          base: { sha: 'abc' },
          head: { sha: 'def', ref: 'some/branch' },
          merged_at: 'sometime',
          title: 'Some title',
          labels: [{ name: 'foo' }, { name: 'bar' }],
          assignee: { login: 'foobar' },
          created_at: '01-01-2022',
          updated_at: '01-09-2022',
        });
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.getPr(1234);
      expect(pr).toMatchObject({ number: 1234, state: 'merged' });
    });

    it(`should return a PR object - 1`, async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [])
        .get('/repos/some/repo/pulls/1234')
        .reply(200, {
          number: 1234,
          state: 'open',
          mergeable_state: 'dirty',
          base: { sha: '1234' },
          head: { ref: 'some/branch' },
          commits: 1,
          title: 'Some title',
          assignees: [{ login: 'foo' }],
          requested_reviewers: [{ login: 'bar' }],
          updated_at: '01-09-2022',
        });
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.getPr(1234);
      expect(pr).toMatchObject({
        bodyStruct: {
          hash: expect.any(String),
        },
        hasAssignees: true,
        number: 1234,
        sourceBranch: 'some/branch',
        state: 'open',
        title: 'Some title',
        updated_at: '01-09-2022',
      });
    });

    it(`should return a PR object - 2`, async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [])
        .get('/repos/some/repo/pulls/1234')
        .reply(200, {
          number: 1234,
          state: 'open',
          base: { sha: '5678' },
          head: { ref: 'some/branch' },
          commits: 1,
          title: 'Some title',
          updated_at: '01-09-2022',
        });
      await github.initRepo({ repository: 'some/repo' });
      const pr = await github.getPr(1234);
      expect(pr).toMatchObject({
        bodyStruct: {
          hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        number: 1234,
        sourceBranch: 'some/branch',
        state: 'open',
        title: 'Some title',
        updated_at: '01-09-2022',
      });
    });
  });

  describe('updatePr(prNo, title, body)', () => {
    it('should update the PR', async () => {
      const pr: UpdatePrConfig = {
        number: 1234,
        prTitle: 'The New Title',
        prBody: 'Hello world again',
      };
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.patch('/repos/some/repo/pulls/1234').reply(200, pr);

      await expect(github.updatePr(pr)).toResolve();
    });

    it('should update and close the PR', async () => {
      const pr: UpdatePrConfig = {
        number: 1234,
        prTitle: 'The New Title',
        prBody: 'Hello world again',
        state: 'closed',
      };
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.patch('/repos/some/repo/pulls/1234').reply(200, pr);

      await expect(github.updatePr(pr)).toResolve();
    });

    it('should update target branch', async () => {
      const pr: UpdatePrConfig = {
        number: 1234,
        prTitle: 'The New Title',
        prBody: 'Hello world again',
        state: 'closed',
        targetBranch: 'new_base',
      };
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.patch('/repos/some/repo/pulls/1234').reply(200, pr);

      await expect(github.updatePr(pr)).toResolve();
    });

    it('should add and remove labels', async () => {
      const pr: UpdatePrConfig = {
        number: 1234,
        prTitle: 'The New Title',
        prBody: 'Hello world again',
        state: 'closed',
        targetBranch: 'new_base',
        addLabels: ['new_label'],
        removeLabels: ['old_label'],
      };
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .patch('/repos/some/repo/pulls/1234')
        .reply(200, {
          number: 91,
          base: { sha: '1234' },
          head: { ref: 'somebranch', repo: { full_name: 'some/repo' } },
          state: 'open',
          title: 'old title',
          updated_at: '01-09-2022',
        })
        .post('/repos/some/repo/issues/1234/labels')
        .reply(200, pr)
        .delete('/repos/some/repo/issues/1234/labels/old_label')
        .reply(200, pr);

      await expect(github.updatePr(pr)).toResolve();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        `Adding labels 'new_label' to #1234`,
      );
      expect(logger.logger.debug).toHaveBeenCalledWith(
        `Deleting label old_label from #1234`,
      );
    });

    describe('addLabels', () => {
      it('warns if adding labels failed', async () => {
        const scope = httpMock.scope(githubApiHost);
        scope.post('/repos/undefined/issues/2/labels').reply(400, {
          message: 'Failed to add labels',
        });
        await expect(github.addLabels(2, ['fail'])).toResolve();
        expect(logger.logger.warn).toHaveBeenCalledWith(
          {
            err: expect.any(Object),
            issueNo: 2,
            labels: ['fail'],
          },
          'Error while adding labels. Skipping',
        );
      });
    });
  });

  describe('reattemptPlatformAutomerge(number, platformPrOptions)', () => {
    const getPrListResp = [
      {
        number: 1234,
        base: { sha: '1234' },
        head: { ref: 'somebranch', repo: { full_name: 'some/repo' } },
        state: 'open',
        title: 'Some PR',
      },
    ];
    const getPrResp = {
      number: 123,
      node_id: 'abcd',
      head: { repo: { full_name: 'some/repo' } },
    };

    const graphqlAutomergeResp = {
      data: {
        enablePullRequestAutoMerge: {
          pullRequest: {
            number: 123,
          },
        },
      },
    };

    const pr: ReattemptPlatformAutomergeConfig = {
      number: 123,
      platformPrOptions: { usePlatformAutomerge: true },
    };

    const mockScope = async (repoOpts: any = {}): Promise<httpMock.Scope> => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo', repoOpts);
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, getPrListResp);
      scope.get('/repos/some/repo/pulls/123').reply(200, getPrResp);
      await github.initRepo({ repository: 'some/repo' });
      return scope;
    };

    const graphqlGetRepo = {
      method: 'POST',
      url: 'https://api.github.com/graphql',
      graphql: { query: { repository: {} } },
    };

    const restGetPrList = {
      method: 'GET',
      url: 'https://api.github.com/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
    };

    const restGetPr = {
      method: 'GET',
      url: 'https://api.github.com/repos/some/repo/pulls/123',
    };

    const graphqlAutomerge = {
      method: 'POST',
      url: 'https://api.github.com/graphql',
      graphql: {
        mutation: {
          __vars: {
            $pullRequestId: 'ID!',
            $mergeMethod: 'PullRequestMergeMethod!',
          },
          enablePullRequestAutoMerge: {
            __args: {
              input: {
                pullRequestId: '$pullRequestId',
                mergeMethod: '$mergeMethod',
              },
            },
          },
        },
        variables: {
          pullRequestId: 'abcd',
          mergeMethod: 'SQUASH',
        },
      },
    };

    it('should set automatic merge', async () => {
      const scope = await mockScope();
      scope.post('/graphql').reply(200, graphqlAutomergeResp);

      await expect(github.reattemptPlatformAutomerge(pr)).toResolve();

      expect(logger.logger.debug).toHaveBeenLastCalledWith(
        'PR platform automerge re-attempted...prNo: 123',
      );

      expect(httpMock.getTrace()).toMatchObject([
        graphqlGetRepo,
        restGetPrList,
        restGetPr,
        graphqlAutomerge,
      ]);
    });

    it('handles unknown error', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .replyWithError('unknown error');

      await expect(github.reattemptPlatformAutomerge(pr)).toResolve();

      expect(logger.logger.warn).toHaveBeenCalledWith(
        {
          err: new ExternalHostError(expect.any(RequestError), 'github'),
        },
        'Error re-attempting PR platform automerge',
      );
    });
  });

  describe('mergePr(prNo)', () => {
    it('should merge the PR', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/pulls?per_page=100&state=all&sort=updated&direction=desc&page=1',
        )
        .reply(200, [
          {
            number: 1234,
            base: { sha: '1234' },
            head: { ref: 'somebranch', repo: { full_name: 'some/repo' } },
            state: 'open',
            title: 'Some PR',
          },
        ])
        .put('/repos/some/repo/pulls/1234/merge')
        .reply(200);
      await github.initRepo({ repository: 'some/repo' });

      const prBefore = await github.getPr(1234); // fetched remotely
      const mergeResult = await github.mergePr({
        id: 1234,
        branchName: 'somebranch',
      });
      const prAfter = await github.getPr(1234); // obtained from cache

      expect(mergeResult).toBeTrue();
      expect(prBefore?.state).toBe('open');
      expect(prAfter?.state).toBe('merged');
    });

    it('should handle merge error', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .put('/repos/some/repo/pulls/1234/merge')
        .replyWithError('merge error');
      await github.initRepo({ repository: 'some/repo' });
      const pr = {
        number: 1234,
        head: {
          ref: 'someref',
        },
      };
      expect(
        await github.mergePr({
          branchName: '',
          id: pr.number,
        }),
      ).toBeFalse();
    });

    it('should handle merge block', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .put('/repos/some/repo/pulls/1234/merge')
        .reply(405, { message: 'Required status check "build" is expected.' });
      await github.initRepo({ repository: 'some/repo' });
      const pr = {
        number: 1234,
        head: {
          ref: 'someref',
        },
      };
      expect(
        await github.mergePr({
          branchName: '',
          id: pr.number,
          strategy: 'merge-commit', // for coverage - has no effect on this test
        }),
      ).toBeFalse();
    });

    it('should handle approvers required', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.put('/repos/some/repo/pulls/1234/merge').reply(405, {
        message: 'Waiting on code owner review from org/team.',
      });
      await github.initRepo({ repository: 'some/repo' });
      const pr = {
        number: 1234,
        head: {
          ref: 'someref',
        },
      };
      expect(
        await github.mergePr({
          branchName: '',
          id: pr.number,
          strategy: 'auto', // for coverage -- has not effect on this test
        }),
      ).toBeFalse();
    });

    it('should warn if automergeStrategy is not supported', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.put('/repos/some/repo/pulls/1234/merge').reply(200);
      await github.initRepo({ repository: 'some/repo' });

      const mergeResult = await github.mergePr({
        id: 1234,
        branchName: 'somebranch',
        strategy: 'fast-forward',
      });

      expect(mergeResult).toBeTrue();
      expect(logger.logger.warn).toHaveBeenCalledWith(
        'Fast-forward merge strategy is not supported by Github. Falling back to merge strategy set for the repository.',
      );
    });

    it('should use configured automergeStrategy', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.put('/repos/some/repo/pulls/1234/merge').reply(200);
      await github.initRepo({ repository: 'some/repo' });

      const mergeResult = await github.mergePr({
        id: 1234,
        branchName: 'somebranch',
        strategy: 'rebase',
      });

      expect(mergeResult).toBeTrue();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        {
          options: {
            body: { merge_method: 'rebase' },
          },
          url: 'repos/some/repo/pulls/1234/merge',
        },
        'mergePr',
      );
    });
  });

  describe('massageMarkdown(input)', () => {
    it('returns updated pr body', () => {
      const input =
        'https://github.com/foo/bar/issues/5 plus also [a link](https://github.com/foo/bar/issues/5)';
      expect(github.massageMarkdown(input)).toMatchSnapshot();
    });

    it('returns not-updated pr body for GHE', async () => {
      const scope = httpMock
        .scope('https://github.company.com')
        .head('/')
        .reply(200, '', { 'x-github-enterprise-version': '3.1.7' })
        .get('/user')
        .reply(200, {
          login: 'renovate-bot',
        })
        .get('/user/emails')
        .reply(200, {});
      initRepoMock(scope, 'some/repo');
      await github.initPlatform({
        endpoint: 'https://github.company.com',
        token: '123test',
      });
      hostRules.find.mockReturnValue({
        token: '123test',
      });
      await github.initRepo({ repository: 'some/repo' });
      const input =
        'https://github.com/foo/bar/issues/5 plus also [a link](https://github.com/foo/bar/issues/5)';
      expect(github.massageMarkdown(input)).toEqual(input);
    });
  });

  describe('mergePr(prNo) - autodetection', () => {
    it('should try squash first', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope.put('/repos/some/repo/pulls/1235/merge').reply(200);
      await github.initRepo({ repository: 'some/repo' });
      const pr = {
        number: 1235,
        head: {
          ref: 'someref',
        },
      };
      expect(
        await github.mergePr({
          branchName: '',
          id: pr.number,
        }),
      ).toBeTrue();
    });

    it('should try merge after squash', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .put('/repos/some/repo/pulls/1236/merge')
        .reply(400, 'no squashing allowed');
      await github.initRepo({ repository: 'some/repo' });
      const pr = {
        number: 1236,
        head: {
          ref: 'someref',
        },
      };
      expect(
        await github.mergePr({
          branchName: '',
          id: pr.number,
        }),
      ).toBeFalse();
    });

    it('should try rebase after merge', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .put('/repos/some/repo/pulls/1237/merge')
        .reply(405, 'no squashing allowed')
        .put('/repos/some/repo/pulls/1237/merge')
        .reply(405, 'no merging allowed')
        .put('/repos/some/repo/pulls/1237/merge')
        .reply(200);
      await github.initRepo({ repository: 'some/repo' });
      const pr = {
        number: 1237,
        head: {
          ref: 'someref',
        },
      };
      expect(
        await github.mergePr({
          branchName: '',
          id: pr.number,
        }),
      ).toBeTrue();
    });

    it('should give up', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .put('/repos/some/repo/pulls/1237/merge')
        .reply(405, 'no squashing allowed')
        .put('/repos/some/repo/pulls/1237/merge')
        .replyWithError('no merging allowed')
        .put('/repos/some/repo/pulls/1237/merge')
        .replyWithError('no rebasing allowed')
        .put('/repos/some/repo/pulls/1237/merge')
        .replyWithError('never gonna give you up');
      await github.initRepo({ repository: 'some/repo' });
      const pr = {
        number: 1237,
        head: {
          ref: 'someref',
        },
      };
      expect(
        await github.mergePr({
          branchName: '',
          id: pr.number,
        }),
      ).toBeFalse();
    });
  });

  describe('getVulnerabilityAlerts()', () => {
    it('avoids fetching if repo has vulnerability alerts disabled', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo', {
        hasVulnerabilityAlertsEnabled: false,
      });
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getVulnerabilityAlerts();
      expect(res).toHaveLength(0);
    });

    it('returns empty if error', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/dependabot/alerts?state=open&direction=asc&per_page=100',
        )
        .reply(200, {});
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getVulnerabilityAlerts();
      expect(res).toHaveLength(0);
    });

    it('returns array if found', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/dependabot/alerts?state=open&direction=asc&per_page=100',
        )
        .reply(200, [
          {
            security_advisory: {
              description: 'description',
              identifiers: [{ type: 'type', value: 'value' }],
              references: [],
            },
            security_vulnerability: {
              package: {
                ecosystem: 'npm',
                name: 'left-pad',
              },
              vulnerable_version_range: '0.0.2',
              first_patched_version: { identifier: '0.0.3' },
            },
            dependency: {
              manifest_path: 'bar/foo',
            },
          },
          {
            security_advisory: {
              description: 'description',
              identifiers: [{ type: 'type', value: 'value' }],
              references: [],
            },
            security_vulnerability: {
              package: {
                ecosystem: 'npm',
                name: 'foo',
              },
              vulnerable_version_range: '0.0.2',
              first_patched_version: null,
            },
            dependency: {
              manifest_path: 'bar/foo',
            },
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getVulnerabilityAlerts();
      expect(res).toHaveLength(2);
    });

    it('returns empty if disabled', async () => {
      // prettier-ignore
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/dependabot/alerts?state=open&direction=asc&per_page=100',
        )
        .reply(200, { data: { repository: {} } });
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getVulnerabilityAlerts();
      expect(res).toHaveLength(0);
    });

    it('handles network error', async () => {
      // prettier-ignore
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/dependabot/alerts?state=open&direction=asc&per_page=100',
        )
        .replyWithError('unknown error');
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getVulnerabilityAlerts();
      expect(res).toHaveLength(0);
    });

    it('calls logger.debug with only items that include securityVulnerability', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/dependabot/alerts?state=open&direction=asc&per_page=100',
        )
        .reply(200, [
          {
            security_advisory: {
              description: 'description',
              identifiers: [{ type: 'type', value: 'value' }],
              references: [],
            },
            security_vulnerability: {
              package: {
                ecosystem: 'npm',
                name: 'left-pad',
              },
              vulnerable_version_range: '0.0.2',
              first_patched_version: { identifier: '0.0.3' },
            },
            dependency: {
              manifest_path: 'bar/foo',
            },
          },

          {
            security_advisory: {
              description: 'description',
              identifiers: [{ type: 'type', value: 'value' }],
              references: [],
            },
            security_vulnerability: null,
            dependency: {
              manifest_path: 'bar/foo',
            },
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      await github.getVulnerabilityAlerts();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        { alerts: { 'npm/left-pad': { '0.0.2': '0.0.3' } } },
        'GitHub vulnerability details',
      );
      expect(logger.logger.error).not.toHaveBeenCalled();
    });

    it('returns normalized names for PIP ecosystem', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      scope
        .get(
          '/repos/some/repo/dependabot/alerts?state=open&direction=asc&per_page=100',
        )
        .reply(200, [
          {
            security_advisory: {
              description: 'description',
              identifiers: [{ type: 'type', value: 'value' }],
              references: [],
            },
            security_vulnerability: {
              package: {
                ecosystem: 'pip',
                name: 'FrIeNdLy.-.BARD',
              },
              vulnerable_version_range: '0.0.2',
              first_patched_version: { identifier: '0.0.3' },
            },
            dependency: {
              manifest_path: 'bar/foo',
            },
          },
        ]);
      await github.initRepo({ repository: 'some/repo' });
      const res = await github.getVulnerabilityAlerts();
      expect(res[0].security_vulnerability!.package.name).toBe('friendly-bard');
    });
  });

  describe('getJsonFile()', () => {
    it('returns null', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.get('/repos/some/repo/contents/file.json').reply(200, {
        content: '',
      });
      const res = await github.getJsonFile('file.json');
      expect(res).toBeNull();
    });

    it('returns file content', async () => {
      const data = { foo: 'bar' };
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.get('/repos/some/repo/contents/file.json').reply(200, {
        content: toBase64(JSON.stringify(data)),
      });
      const res = await github.getJsonFile('file.json');
      expect(res).toEqual(data);
    });

    it('returns file content in json5 format', async () => {
      const json5Data = `
        {
          // json5 comment
          foo: 'bar'
        }
      `;
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.get('/repos/some/repo/contents/file.json5').reply(200, {
        content: toBase64(json5Data),
      });
      const res = await github.getJsonFile('file.json5');
      expect(res).toEqual({ foo: 'bar' });
    });

    it('returns file content from given repo', async () => {
      const data = { foo: 'bar' };
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'different/repo');
      await github.initRepo({ repository: 'different/repo' });
      scope.get('/repos/different/repo/contents/file.json').reply(200, {
        content: toBase64(JSON.stringify(data)),
      });
      const res = await github.getJsonFile('file.json', 'different/repo');
      expect(res).toEqual(data);
    });

    it('returns file content from branch or tag', async () => {
      const data = { foo: 'bar' };
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.get('/repos/some/repo/contents/file.json?ref=dev').reply(200, {
        content: toBase64(JSON.stringify(data)),
      });
      const res = await github.getJsonFile('file.json', 'some/repo', 'dev');
      expect(res).toEqual(data);
    });

    it('throws on malformed JSON', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.get('/repos/some/repo/contents/file.json').reply(200, {
        content: toBase64('!@#'),
      });
      await expect(github.getJsonFile('file.json')).rejects.toThrow();
    });

    it('throws on errors', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope
        .get('/repos/some/repo/contents/file.json')
        .replyWithError('some error');

      await expect(github.getJsonFile('file.json')).rejects.toThrow();
    });
  });

  describe('pushFiles', () => {
    beforeEach(() => {
      git.prepareCommit.mockImplementation(({ files }) =>
        Promise.resolve({
          parentCommitSha: '1234567' as LongCommitSha,
          commitSha: '7654321' as LongCommitSha,
          files,
        }),
      );
      git.fetchBranch.mockImplementation(() =>
        Promise.resolve('0abcdef' as LongCommitSha),
      );
    });

    it('returns null if pre-commit phase has failed', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      git.prepareCommit.mockResolvedValueOnce(null);

      await github.initRepo({ repository: 'some/repo' });

      const res = await github.commitFiles({
        branchName: 'foo/bar',
        files: [
          { type: 'addition', path: 'foo.bar', contents: 'foobar' },
          { type: 'deletion', path: 'baz' },
          { type: 'deletion', path: 'qux' },
        ],
        message: 'Foobar',
      });

      expect(res).toBeNull();
    });

    it('returns null on REST error', async () => {
      const scope = httpMock.scope(githubApiHost);
      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });
      scope.post('/repos/some/repo/git/trees').replyWithError('unknown');

      const res = await github.commitFiles({
        branchName: 'foo/bar',
        files: [{ type: 'addition', path: 'foo.bar', contents: 'foobar' }],
        message: 'Foobar',
      });

      expect(res).toBeNull();
    });

    it('commits and returns SHA string', async () => {
      git.pushCommitToRenovateRef.mockResolvedValueOnce();
      git.listCommitTree.mockResolvedValueOnce([]);

      const scope = httpMock.scope(githubApiHost);

      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });

      scope
        .post('/repos/some/repo/git/trees')
        .reply(200, { sha: '111' })
        .post('/repos/some/repo/git/commits')
        .reply(200, { sha: '222' })
        .head('/repos/some/repo/git/commits/222')
        .reply(200)
        .post('/repos/some/repo/git/refs')
        .reply(200);
      vi.spyOn(branch, 'remoteBranchExists').mockResolvedValueOnce(false);

      const res = await github.commitFiles({
        branchName: 'foo/bar',
        files: [{ type: 'addition', path: 'foo.bar', contents: 'foobar' }],
        message: 'Foobar',
      });

      expect(res).toBe('0abcdef');
    });

    it('performs rebase', async () => {
      git.pushCommitToRenovateRef.mockResolvedValueOnce();
      git.listCommitTree.mockResolvedValueOnce([]);

      const scope = httpMock.scope(githubApiHost);

      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });

      scope
        .post('/repos/some/repo/git/trees')
        .reply(200, { sha: '111' })
        .post('/repos/some/repo/git/commits')
        .reply(200, { sha: '222' })
        .head('/repos/some/repo/git/commits/222')
        .reply(200)
        .patch('/repos/some/repo/git/refs/heads/foo/bar')
        .reply(200);
      vi.spyOn(branch, 'remoteBranchExists').mockResolvedValueOnce(true);

      const res = await github.commitFiles({
        branchName: 'foo/bar',
        files: [{ type: 'addition', path: 'foo.bar', contents: 'foobar' }],
        message: 'Foobar',
      });

      expect(res).toBe('0abcdef');
    });

    it('continues if rebase fails due to 422', async () => {
      git.pushCommitToRenovateRef.mockResolvedValueOnce();
      git.listCommitTree.mockResolvedValueOnce([]);

      const scope = httpMock.scope(githubApiHost);

      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });

      scope
        .post('/repos/some/repo/git/trees')
        .reply(200, { sha: '111' })
        .post('/repos/some/repo/git/commits')
        .reply(200, { sha: '222' })
        .head('/repos/some/repo/git/commits/222')
        .reply(200)
        .patch('/repos/some/repo/git/refs/heads/foo/bar')
        .reply(422)
        .post('/repos/some/repo/git/refs')
        .reply(200);
      vi.spyOn(branch, 'remoteBranchExists').mockResolvedValueOnce(true);

      const res = await github.commitFiles({
        branchName: 'foo/bar',
        files: [{ type: 'addition', path: 'foo.bar', contents: 'foobar' }],
        message: 'Foobar',
      });

      expect(res).toBe('0abcdef');
    });

    it('aborts if rebase fails due to non-422', async () => {
      git.pushCommitToRenovateRef.mockResolvedValueOnce();
      git.listCommitTree.mockResolvedValueOnce([]);

      const scope = httpMock.scope(githubApiHost);

      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });

      scope
        .post('/repos/some/repo/git/trees')
        .reply(200, { sha: '111' })
        .post('/repos/some/repo/git/commits')
        .reply(200, { sha: '222' })
        .head('/repos/some/repo/git/commits/222')
        .reply(200)
        .patch('/repos/some/repo/git/refs/heads/foo/bar')
        .reply(404);
      vi.spyOn(branch, 'remoteBranchExists').mockResolvedValueOnce(true);

      const res = await github.commitFiles({
        branchName: 'foo/bar',
        files: [{ type: 'addition', path: 'foo.bar', contents: 'foobar' }],
        message: 'Foobar',
      });

      expect(res).toBeNull();
    });

    it("aborts if commit SHA doesn't exist", async () => {
      git.pushCommitToRenovateRef.mockResolvedValueOnce();
      git.listCommitTree.mockResolvedValueOnce([]);

      const scope = httpMock.scope(githubApiHost);

      initRepoMock(scope, 'some/repo');
      await github.initRepo({ repository: 'some/repo' });

      scope
        .post('/repos/some/repo/git/trees')
        .reply(200, { sha: '111' })
        .post('/repos/some/repo/git/commits')
        .reply(200, { sha: '222' })
        .head('/repos/some/repo/git/commits/222')
        .reply(404);

      const res = await github.commitFiles({
        branchName: 'foo/bar',
        files: [{ type: 'addition', path: 'foo.bar', contents: 'foobar' }],
        message: 'Foobar',
      });

      expect(res).toBeNull();
    });
  });
});
