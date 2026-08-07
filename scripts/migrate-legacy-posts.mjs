import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const D1_DATABASE = process.env.LEGACY_D1_DATABASE || "blog-d1";
const R2_BUCKET = process.env.LEGACY_R2_BUCKET || "blog-r2";
const SITE_ORIGIN = "https://630902.xyz";
const projectRoot = process.cwd();
const commandCwd = process.env.TEMP || projectRoot;
const wranglerCli = path.join(
	projectRoot,
	"node_modules",
	"wrangler",
	"bin",
	"wrangler.js",
);

if (!existsSync(wranglerCli)) {
	throw new Error(
		`Wrangler CLI was not found at ${wranglerCli}. Install project dependencies first.`,
	);
}

function runWrangler(args) {
	return execFileSync(process.execPath, [wranglerCli, ...args], {
		cwd: commandCwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

function runWranglerJson(args) {
	const output = runWrangler([...args, "--json"]);
	const start = output.indexOf("[");
	const end = output.lastIndexOf("]");
	if (start < 0 || end < start) {
		throw new Error(
			`Unable to parse Wrangler JSON output for ${args.join(" ")}`,
		);
	}
	return JSON.parse(output.slice(start, end + 1));
}

function query(sql) {
	const payload = runWranglerJson([
		"d1",
		"execute",
		D1_DATABASE,
		"--remote",
		"--command",
		sql,
	]);
	return payload[0]?.results ?? [];
}

function dateFromUnix(seconds) {
	return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

function escapeMarkdown(value) {
	return String(value ?? "")
		.replace(/\\/g, "\\\\")
		.replace(/([`*_[\]~])/g, "\\$1")
		.replace(/^\s*([#>+-])(?=\s)/gm, "\\$1");
}

function escapeUrl(value) {
	return String(value ?? "").replace(/[()\\]/g, "\\$&");
}

function renderInline(nodes, imageUrl) {
	return (nodes ?? [])
		.map((node) => {
			if (node.type === "hardBreak") return "  \n";
			if (node.type === "image") return renderImage(node, imageUrl);
			if (node.type !== "text") return renderInline(node.content, imageUrl);

			let value = escapeMarkdown(node.text ?? "");
			for (const mark of node.marks ?? []) {
				switch (mark.type) {
					case "code":
						value = `\`${value.replace(/`/g, "\\`")}\``;
						break;
					case "bold":
						value = `**${value}**`;
						break;
					case "link": {
						const href = mark.attrs?.href ?? "";
						value = `[${value}](<${escapeUrl(href)}>)`;
						break;
					}
					default:
						break;
				}
			}
			return value;
		})
		.join("");
}

function renderImage(node, imageUrl) {
	const attrs = node.attrs ?? {};
	const src = imageUrl(attrs.src ?? "");
	const alt = escapeMarkdown(attrs.alt ?? "");
	const title = attrs.title ? ` "${escapeMarkdown(attrs.title)}"` : "";
	const image = `![${alt}](${escapeUrl(src)}${title})`;
	return attrs.caption
		? `${image}\n\n*${escapeMarkdown(attrs.caption)}*`
		: image;
}

function renderListItem(node, marker, imageUrl) {
	const blocks = (node.content ?? [])
		.map((child) => renderBlock(child, imageUrl))
		.filter(Boolean);
	if (blocks.length === 0) return `${marker} `;
	const first = blocks[0].replace(/\n/g, "\n  ");
	const rest = blocks
		.slice(1)
		.map((block) => `\n  ${block.replace(/\n/g, "\n  ")}`);
	return `${marker} ${first}${rest.join("")}`;
}

function renderBlock(node, imageUrl) {
	if (!node) return "";
	if (node.type === "doc") {
		return (node.content ?? [])
			.map((child) => renderBlock(child, imageUrl))
			.filter(Boolean)
			.join("\n\n");
	}

	switch (node.type) {
		case "paragraph":
			return renderInline(node.content, imageUrl);
		case "heading": {
			const level = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 6);
			return `${"#".repeat(level)} ${renderInline(node.content, imageUrl)}`;
		}
		case "image":
			return renderImage(node, imageUrl);
		case "codeBlock": {
			const language = node.attrs?.language || "text";
			const code = (node.content ?? [])
				.map((child) => child.text ?? "")
				.join("");
			const fence = code.includes("```") ? "````" : "```";
			return `${fence}${language}\n${code}\n${fence}`;
		}
		case "bulletList":
			return (node.content ?? [])
				.map((child) => renderListItem(child, "-", imageUrl))
				.join("\n");
		case "orderedList": {
			const start = Number(node.attrs?.start ?? 1);
			return (node.content ?? [])
				.map((child, index) =>
					renderListItem(child, `${start + index}.`, imageUrl),
				)
				.join("\n");
		}
		case "listItem":
			return (node.content ?? [])
				.map((child) => renderBlock(child, imageUrl))
				.filter(Boolean)
				.join("\n\n");
		default:
			return renderInline(node.content, imageUrl);
	}
}

function imageKeyFromUrl(rawUrl) {
	try {
		const parsed = new URL(rawUrl, SITE_ORIGIN);
		const prefix = "/images/";
		return parsed.pathname.startsWith(prefix)
			? parsed.pathname.slice(prefix.length)
			: null;
	} catch {
		return null;
	}
}

const posts = query(`
	SELECT
		p.id,
		p.title,
		p.summary,
		p.cover_image_url,
		p.read_time_in_minutes,
		p.slug,
		p.published_at,
		p.pinned_at,
		p.updated_at,
		group_concat(t.name, '|||') AS tags
	FROM posts p
	LEFT JOIN post_tags pt ON pt.post_id = p.id
	LEFT JOIN tags t ON t.id = pt.tag_id
	WHERE p.status = 'published'
	GROUP BY p.id
	ORDER BY p.published_at DESC, p.id DESC;
`);

const media = query(`
	SELECT
		pm.post_id,
		m.key,
		m.url,
		m.mime_type
	FROM post_media pm
	JOIN media m ON m.id = pm.media_id
	ORDER BY pm.post_id, m.id;
`);

const mediaByKey = new Map(media.map((item) => [item.key, item]));
const mediaDir = path.join(projectRoot, "public", "images", "legacy");
mkdirSync(mediaDir, { recursive: true });

for (const item of media) {
	if (!/^[a-zA-Z0-9._-]+$/.test(item.key)) {
		throw new Error(`Unexpected R2 object key: ${item.key}`);
	}
	const destination = path.join(mediaDir, item.key);
	if (!existsSync(destination) || statSync(destination).size === 0) {
		runWrangler([
			"r2",
			"object",
			"get",
			`${R2_BUCKET}/${item.key}`,
			"--remote",
			"--file",
			destination,
		]);
	}
}

const postsDir = path.join(projectRoot, "src", "content", "posts");
mkdirSync(postsDir, { recursive: true });

for (const post of posts) {
	const contentRows = query(
		`SELECT content_json FROM posts WHERE id = ${Number(post.id)};`,
	);
	const contentJson = contentRows[0]?.content_json;
	if (!contentJson) throw new Error(`Post ${post.id} has no content_json`);

	const document = JSON.parse(contentJson);
	const imageUrl = (rawUrl) => {
		const key = imageKeyFromUrl(rawUrl);
		return key && mediaByKey.has(key) ? `/images/legacy/${key}` : rawUrl;
	};
	const body = `${renderBlock(document, imageUrl).trim()}\n`;
	const tags = post.tags ? post.tags.split("|||").filter(Boolean) : [];
	const coverKey = imageKeyFromUrl(post.cover_image_url ?? "");
	const cover =
		coverKey && mediaByKey.has(coverKey)
			? `/images/legacy/${coverKey}`
			: (post.cover_image_url ?? "");
	const published = dateFromUnix(post.published_at);
	const updated = dateFromUnix(post.updated_at || post.published_at);
	const frontmatter = [
		"---",
		`title: ${JSON.stringify(post.title)}`,
		`published: ${published}`,
		`updated: ${updated}`,
		`description: ${JSON.stringify(post.summary ?? "")}`,
		`image: ${JSON.stringify(cover)}`,
		`tags: ${JSON.stringify(tags)}`,
		`category: ""`,
		"draft: false",
		`pinned: ${post.pinned_at == null ? "false" : "true"}`,
		"comment: true",
		'author: "xiaoao"',
		'sourceLink: ""',
		'licenseName: ""',
		'licenseUrl: ""',
		"---",
	].join("\n");

	writeFileSync(
		path.join(postsDir, `${post.slug}.md`),
		`${frontmatter}\n${body}`,
		"utf8",
	);
	console.log(`Migrated ${post.slug} (${body.length} body chars)`);
}

console.log(
	`Migrated ${posts.length} posts and ${media.length} media files from ${D1_DATABASE}.`,
);
