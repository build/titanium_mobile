'use strict';

const fs = require('fs-extra');
const path = require('path');
const jsanalyze = require('node-titanium-sdk/lib/jsanalyze');

// RegExps used to match against files
const FILENAME_REGEXP = /^(.*)\.(\w+)$/;
const LAUNCH_IMAGE_REGEXP = /^(Default(-(Landscape|Portrait))?(-[0-9]+h)?(@[2-9]x)?)\.png$/;
const LAUNCH_LOGO_REGEXP = /^LaunchLogo(?:@([23])x)?(?:~(iphone|ipad))?\.(?:png|jpg)$/;
const BUNDLE_FILE_REGEXP = /.+\.bundle\/.+/;

class Result {
	constructor() {
		this.appIcons = new Map();
		this.cssFiles = new Map();
		this.jsFiles = new Map();
		this.launchImages = new Map();
		this.launchLogos = new Map();
		this.imageAssets = new Map();
		this.resourcesToCopy = new Map();
		this.htmlJsFiles = new Set();
	}

	/**
	 * If a js file is references by HTML, don't minify/transpile/etc, treat like any resource we just copy over as-is
	 */
	dontProcessJsFilesReferencedFromHTML() {
		for (const file of this.htmlJsFiles.keys()) {
			if (this.jsFiles.has(file)) {
				this.resourcesToCopy.set(file, this.jsFiles.get(file));
				this.jsFiles.delete(file);
			}
		}
	}

	/**
	 * @param  {Result[]} results to be merged
	 * @returns {Result}
	 */
	static merge(results) {
		const merged = new Result();
		const mapFields = [ 'appIcons', 'cssFiles', 'jsFiles', 'launchImages', 'launchLogos', 'imageAssets', 'resourcesToCopy' ];
		for (const key of mapFields) {
			const maps = results.map(aResult => aResult[key]).filter(m => m.size !== 0);
			if (maps.length !== 0) {
				merged[key] = maps.reduce((combined, list) => {
					return new Map([ ...combined, ...list ]);
				}, merged[key]);
			}
		}
		const sets = [ 'htmlJsFiles' ];
		for (const key of sets) {
			const sets = results.map(aResult => aResult[key]).filter(s => s.size !== 0);
			if (sets.length !== 0) {
				merged[key] = sets.reduce((combined, list) => {
					return new Set([ ...combined, ...list ]);
				}, merged[key]);
			}
		}
		return merged;
	}
}

class Walker {
	/**
	 *
	 * @param {object} options options
	 * @param {string} options.tiappIcon tiapp icon filename
	 * @param {boolean} [options.useAppThinning=false] use app thinning?
	 * @param {RegExp} [options.ignoreDirs=undefined] RegExp used to filter directories
	 * @param {RegExp} [options.ignoreFiles=undefined] RegExp used to filter files
	 */
	constructor(options) {
		this.useAppThinning = options.useAppThinning;
		this.ignoreDirs = options.ignoreDirs;
		this.ignoreFiles = options.ignoreFiles;

		const appIcon = options.tiappIcon.match(FILENAME_REGEXP);
		this.appIconRegExp = appIcon && new RegExp('^' + appIcon[1].replace(/\./g, '\\.') + '(.*)\\.png$'); // eslint-disable-line security/detect-non-literal-regexp
	}

	/**
	 * Walks a directory tree gathering the files and throwing them into different buckets to be handled separately:
	 * JS to encrypt/minify/transpile/etc
	 * CSS
	 * HTML to analyze (though we do that here...)
	 * JPG/PNG to look for app icons/launch images
	 * Everything else to copy straight up
	 * @param {string} src source path
	 * @param {string} dest destination path
	 * @param {RegExp} ignore regexp of directories/files to ignore
	 * @param {string} [origSrc] A way of preserving the original root src directory we started with?
	 * @param {string} [prefix] replaces the original src dir name in the relative path we record
	 * @returns {Promise<Result>} collected resources/assets
	 */
	async walk(src, dest, ignore, origSrc, prefix) {
		const results = new Result();
		// TODO: Instead of checking existence here, why not just catch Error on readdirSync below? (what's faster?)
		if (!await fs.exists(src)) {
			return results;
		}

		return this._walkDir(results, src, dest, ignore, origSrc, prefix);
	}

	/**
	 * Walks a directory tree gathering the files and throwing them into different buckets to be handled separately:
	 * JS to encrypt/minify/transpile/etc
	 * CSS
	 * HTML to analyze (though we do that here...)
	 * JPG/PNG to look for app icons/launch images
	 * Everything else to copy straight up
	 * @param {Result} results collected results
	 * @param {string} src source path
	 * @param {string} dest destination path
	 * @param {RegExp} ignore regexp of directories/files to ignore
	 * @param {string} [origSrc] A way of preserving the original root src directory we started with?
	 * @param {string} [prefix] replaces the original src dir name in the relative path we record
	 * @returns {Promis<Result>} collected results
	 */
	async _walkDir(results, src, dest, ignore, origSrc, prefix) {
		const list = await fs.readdir(src, { withFileTypes: true });
		await Promise.all(list.map(dirent => this._visitListing(results, dirent, src, dest, ignore, origSrc, prefix)));
		return results; // We know all results here are from a single call in to walk, so we merge them as we go (by passing along the results object)
	}

	/**
	 * @param {Result} results collecting results
	 * @param {fs.Dir} dirent directory entry
	 * @param {string} src source directory path
	 * @param {string} dest destination path
	 * @param {RegExp} ignore regexp of directories/files to ignore
	 * @param {string} [origSrc] original source dir/path
	 * @param {string} [prefix] prefix to be used in relative path in place of origSrc || src
	 */
	async _visitListing(results, dirent, src, dest, ignore, origSrc, prefix) {
		const name = dirent.name;
		if (ignore && ignore.test(name)) { // if we should ignore this file/dir, skip it
			return;
		}

		const from = path.join(src, name);
		const to = path.join(dest, name);
		//  If it's a symlink we need to resolve if it's truly a directory or file...
		if (dirent.isSymbolicLink()) {
			dirent = await fs.stat(from); // thankfully both fs.Stats and fs.Dirent have isDirectoyr() methods on them
		}
		if (dirent.isDirectory()) {
			if (this.ignoreDirs && this.ignoreDirs.test(name)) { // if we should ignore this dir, skip it
				return;
			}
			// recurse
			return this._walkDir(results, from, to, null, origSrc || src, prefix);
		}

		return this._visitFile(results, from, to, name, src, origSrc, prefix);
	}

	/**
	 * @param {Result} results collecting results
	 * @param {string} from full source filepath
	 * @param {string} to full destination filepath
	 * @param {string} name base filename
	 * @param {string} src source directory path
	 * @param {string} [origSrc] original source dir/path
	 * @param {string} [prefix] prefix to be used in relative path in place of origSrc || src
	 */
	_visitFile(results, from, to, name, src, origSrc, prefix) {
		// if we should ignore this file, skip it
		if (this.ignoreFiles && this.ignoreFiles.test(name)) {
			return;
		}
		// TODO: Why not use path methods to grab the basename/extension?
		const parts = name.match(FILENAME_REGEXP),
			info = {
				name: parts ? parts[1] : name,
				ext: parts ? parts[2] : null,
				src: from,
				dest: to // NOTE: Removed srcStat property since it appeared to be unused (and instead re-calculated by copyResources())
			};
		const relPath = from.replace((origSrc || src) + '/', prefix ? prefix + '/' : '');

		switch (parts && parts[2]) {
			case 'js':
				results.jsFiles.set(relPath, info);
				break;

			case 'css':
				results.cssFiles.set(relPath, info);
				break;

			case 'png':
				// check if we have an app icon
				if (!origSrc) { // I think this is to try and only check in the first root src dir?
					if (this.appIconRegExp) {
						const m = name.match(this.appIconRegExp);
						if (m) {
							info.tag = m[1];
							results.appIcons.set(relPath, info);
							return;
						}
					}

					if (LAUNCH_IMAGE_REGEXP.test(name)) {
						results.launchImages.set(relPath, info);
						return;
					}
				}
				// fall through to lump with JPG...
			case 'jpg':
				// if the image is the LaunchLogo.png, then let that pass so we can use it
				// in the LaunchScreen.storyboard
				const m = name.match(LAUNCH_LOGO_REGEXP);
				if (m) {
					info.scale = m[1];
					info.device = m[2];
					results.launchLogos.set(relPath, info);

				// if we are using app thinning, then don't copy the image, instead mark the
				// image to be injected into the asset catalog. Also, exclude images that are
				// managed by their bundles.
				} else if (this.useAppThinning && !relPath.match(BUNDLE_FILE_REGEXP)) {
					results.imageAssets.set(relPath, info);
				} else {
					results.resourcesToCopy.set(relPath, info);
				}
				break;

			case 'html':
				jsanalyze.analyzeHtmlFile(from, relPath.split('/').slice(0, -1).join('/')).forEach(file => {
					results.htmlJsFiles.add(file);
				});
				// fall through to default case

			default:
				results.resourcesToCopy.set(relPath, info);
		}
	}
}

Walker.Result = Result; // FIXME: Export this stuff properly!
module.exports = Walker;
