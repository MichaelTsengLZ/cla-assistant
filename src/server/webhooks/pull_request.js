require('../documents/user');

// services
let pullRequest = require('../services/pullRequest');
let status = require('../services/status');
let cla = require('../services/cla');
let repoService = require('../services/repo');
let orgService = require('../services/org');
let log = require('../services/logger');
let config = require('../../config');
let User = require('mongoose').model('User');


//////////////////////////////////////////////////////////////////////////////////////////////
// Github Pull Request Webhook Handler
//////////////////////////////////////////////////////////////////////////////////////////////

function storeRequest(committers, repo, owner, number) {
    committers.forEach(function (committer) {
        User.findOne({ name: committer }, (err, user) => {
            let pullRequest = { repo: repo, owner: owner, numbers: [number] };
            if (!user) {
                User.create({ name: committer, requests: [pullRequest] }, (err, user) => {
                    if (err) {
                        log.warn(new Error(err).stack);
                    }
                });
                return;
            }
            if (!user.requests || user.requests.length < 1) {
                user.requests = user.requests ? user.requests : [];
                user.requests.push(pullRequest);
                user.save();
                return;
            }
            let repoPullRequests = user.requests.find((request) => {
                return request.repo === repo && request.owner === owner;
            });
            if (repoPullRequests.numbers.indexOf(number) < 0) {
                repoPullRequests.numbers.push(number);
                user.save();
            }
        });
    });
}

function updateStatusAndComment(args) {
    repoService.getPRCommitters(args, function (err, committers) {
        if (!err && committers && committers.length > 0) {
            cla.check(args, function (error, signed, user_map) {
                if (error) {
                    log.warn(new Error(error).stack);
                }
                args.signed = signed;
                status.update(args);
                // if (!signed) {
                pullRequest.badgeComment(
                    args.owner,
                    args.repo,
                    args.number,
                    signed,
                    user_map
                );
                if (user_map && user_map.not_signed) {
                    storeRequest(user_map.not_signed, args.repo, args.owner, args.number);
                }
                // }
            });
        } else {
            if (!args.handleCount || args.handleCount < 2) {
                args.handleCount = args.handleCount ? ++args.handleCount : 1;
                setTimeout(function () {
                    updateStatusAndComment(args);
                }, 10000 * args.handleCount * args.handleDelay);
            } else {
                log.warn(new Error(err).stack, 'PR committers: ', committers, 'called with args: ', args);
            }
        }
    });
};

function handleWebHook(args) {
    cla.isClaRequired(args, function (error, isClaRequired) {
        if (error) {
            return log.error(error);
        }
        if (!isClaRequired) {
            status.updateForClaNotRequired(args);
            pullRequest.deleteComment({
                repo: args.repo,
                owner: args.owner,
                number: args.number
            });
            return;
        }
        updateStatusAndComment(args);
    });
}

module.exports = function (req, res) {
    if (['opened', 'reopened', 'synchronize'].indexOf(req.args.action) > -1 && (req.args.repository && req.args.repository.private == false)) {
        if (req.args.pull_request && req.args.pull_request.html_url) {
            console.log('pull request ' + req.args.action + ' ' + req.args.pull_request.html_url);
        }
        let args = {
            owner: req.args.repository.owner.login,
            repoId: req.args.repository.id,
            repo: req.args.repository.name,
            number: req.args.number
        };
        args.orgId = req.args.organization ? req.args.organization.id : req.args.repository.owner.id;
        args.handleDelay = req.args.handleDelay != undefined ? req.args.handleDelay : 1; // needed for unitTests


        setTimeout(function () {
            cla.getLinkedItem(args, function (err, item) {
                if (!item) {
                    return;
                }
                let nullCla = !item.gist;
                let isExcluded = item.orgId && item.isRepoExcluded && item.isRepoExcluded(args.repo);
                if (nullCla || isExcluded) {
                    return;
                }
                args.token = item.token;
                args.gist = item.gist;
                if (item.repoId) {
                    args.orgId = undefined;
                }
                return handleWebHook(args);
            });
        }, config.server.github.enforceDelay);
    }

    res.status(200).send('OK');
};