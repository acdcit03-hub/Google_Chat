import JSZip from "jszip";
import {
    getEmployeeFieldNamesModel,
    getOfferLetterEmployeeModel,
    getOfferLetterFormatHistoryModel,
    getOfferLetterFormatModel,
    getOfferLetterTemplateFileModel,
    updateOfferLetterTemplateModel
} from "../../models/Employee/offerLetterFormat.model.js";

function getUploadedBy(req) {
    return String(
        req.user?.username ||
        req.headers["x-hrms-username"] ||
        req.headers["x-username"] ||
        "system"
    ).trim();
}

function restoreHtml(value) {
    if (typeof value !== "string") return value;

    let text = value.trim();
    if (text.startsWith('"') && text.endsWith('"')) {
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed === "string") text = parsed;
        } catch {
            text = text.slice(1, -1);
        }
    }

    return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16))
    );
}

function formatResponse(template) {
    if (!template) return null;

    return {
        id: template.id,
        content_html: restoreHtml(template.content_html),
        updated_at: template.updated_at,
        updated_by: template.updated_by
    };
}

export const updateOfferLetterTemplate = async (req, res) => {
    try {
        const { content_html } = req.body || {};
        if (typeof content_html !== "string" || !content_html.trim()) {
            return res.status(400).json({
                success: false,
                message: "content_html is required"
            });
        }

        const result = await updateOfferLetterTemplateModel({
            content_html,
            updated_by: getUploadedBy(req)
        });

        return res.status(result.replaced ? 200 : 201).json({
            success: true,
            message: result.replaced
                ? "Offer letter template updated successfully"
                : "Offer letter template saved successfully",
            data: formatResponse(result.template)
        });
    } catch (error) {
        console.error("UPDATE OFFER LETTER TEMPLATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update offer letter template",
            error: error.message
        });
    }
};

export const getOfferLetterFormat = async (_req, res) => {
    try {
        const format = await getOfferLetterFormatModel();

        return res.status(200).json({
            success: true,
            message: "Offer letter template fetched successfully",
            data: formatResponse(format)
        });
    } catch (error) {
        console.error("GET OFFER LETTER FORMAT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch offer letter format",
            error: error.message
        });
    }
};

const escapeXml = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const htmlToLines = (html) => String(html || "")
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .split("\n")
    .map(line => line.trim());

const fillOfferLetter = (template, employee) => {
    const fullName = [employee.first_name, employee.middle_name, employee.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
    const salary = employee.current_salary == null
        ? ""
        : Number(employee.current_salary).toLocaleString("en-IN");
    const values = {
        first_name: employee.first_name || "",
        last_name: employee.last_name || "",
        middle_name: employee.middle_name || "",
        employee_name: fullName,
        designation: employee.designation || "",
        department: employee.department || "",
        date_of_joining: employee.date_of_joining || "",
        joining_date: employee.date_of_joining || "",
        work_location: employee.work_location || "",
        company_name: employee.work_location || "",
        current_salary: salary,
        reporting_manager: employee.reporting_manager || "",
        email_id: employee.email_id || "",
        mobile_number: employee.mobile_number || ""
    };

    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ""
    );
};

const fillOfferLetterDocx = async (templateBuffer, employee) => {
    const fullName = [employee.first_name, employee.middle_name, employee.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
    const salary = employee.current_salary == null
        ? ""
        : Number(employee.current_salary).toLocaleString("en-IN");
    const letterDate = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    }).format(new Date());
    const values = {
        date: letterDate,
        first_name: employee.first_name || "",
        last_name: employee.last_name || "",
        middle_name: employee.middle_name || "",
        employee_name: fullName,
        designation: employee.designation || "",
        department: employee.department || "",
        date_of_joining: employee.date_of_joining || "",
        joining_date: employee.date_of_joining || "",
        work_location: employee.work_location || "",
        company_name: employee.work_location || "",
        current_salary: salary,
        reporting_manager: employee.reporting_manager || "",
        email_id: employee.email_id || "",
        mobile_number: employee.mobile_number || "",
        notice_period: employee.notice_period || ""
    };

    const zip = await JSZip.loadAsync(templateBuffer);
    const document = zip.file("word/document.xml");
    if (!document) {
        throw new Error("Offer letter template is missing word/document.xml");
    }

    const xml = await document.async("string");
    const filled = xml.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key)
            ? escapeXml(values[key])
            : match
    );
    zip.file("word/document.xml", filled);
    return zip.generateAsync({ type: "nodebuffer" });
};

const isOfferTitle = (line) => {
    const value = line.trim().toLowerCase();
    return (
        value === "strictly private and confidential" ||
        value === "appointment letter" ||
        value === "offer letter" ||
        /^annexure\b/.test(value)
    );
};

const isOfferHeading = (line) => {
    const value = line.trim();
    return value.endsWith(":") && value.length <= 60 && !/^signature\s*:/i.test(value);
};

const splitOfferColumns = (line) => {
    const match = String(line).match(/^(\S(?:.*?\S)?)\s{2,}(\S.*)$/);
    if (!match) return null;
    const label = match[1].trim();
    const value = match[2].trim();
    if (!label || !value || label.length > 45) return null;
    return { label, value };
};

const parseOfferLetterBlocks = (content) => {
    const text = String(content || "")
        .replace(/\r\n/g, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"");
    const blocks = [];
    let tableRows = [];

    const flushTable = () => {
        if (!tableRows.length) return;
        blocks.push({ type: "table", rows: tableRows });
        tableRows = [];
    };

    for (const rawLine of text.split("\n")) {
        const line = rawLine.replace(/\s+$/g, "");
        const trimmed = line.trim();

        if (!trimmed) {
            flushTable();
            blocks.push({ type: "blank" });
            continue;
        }

        if (isOfferTitle(trimmed)) {
            flushTable();
            blocks.push({ type: "title", text: trimmed });
            continue;
        }

        if (/^(?:•|●|-)\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
            flushTable();
            blocks.push({ type: "bullet", text: trimmed });
            continue;
        }

        const columns = splitOfferColumns(line);
        if (columns) {
            tableRows.push(columns);
            continue;
        }

        flushTable();
        blocks.push({
            type: isOfferHeading(trimmed) ? "heading" : "paragraph",
            text: trimmed
        });
    }

    flushTable();
    return blocks;
};

const offerParagraph = (text, options = {}) => {
    const align = options.align ? `<w:jc w:val="${options.align}"/>` : "";
    const bold = options.bold ? "<w:b/>" : "";
    const size = options.size || "22";
    const before = options.before ?? 0;
    const after = options.after ?? 80;
    const indent = options.indent
        ? `<w:ind w:left="${options.indent}"/>`
        : "";
    const safeText = escapeXml(
        String(text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    );
    const run = safeText
        ? `<w:r>
                <w:rPr>
                    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
                    ${bold}
                    <w:sz w:val="${size}"/>
                    <w:szCs w:val="${size}"/>
                </w:rPr>
                <w:t xml:space="preserve">${safeText}</w:t>
            </w:r>`
        : "";

    return `<w:p>
            <w:pPr>
                <w:spacing w:before="${before}" w:after="${after}" w:line="276" w:lineRule="auto"/>
                ${align}
                ${indent}
            </w:pPr>
            ${run}
        </w:p>`;
};

const offerTable = (rows) => {
    const body = rows.map(row => `
        <w:tr>
            <w:tc>
                <w:tcPr><w:tcW w:w="3200" w:type="dxa"/></w:tcPr>
                ${offerParagraph(row.label, { bold: true, size: "22", after: 40 })}
            </w:tc>
            <w:tc>
                <w:tcPr><w:tcW w:w="6880" w:type="dxa"/></w:tcPr>
                ${offerParagraph(row.value, { size: "22", after: 40 })}
            </w:tc>
        </w:tr>
    `).join("");

    return `<w:tbl>
            <w:tblPr>
                <w:tblW w:w="10080" w:type="dxa"/>
                <w:tblBorders>
                    <w:top w:val="nil"/>
                    <w:left w:val="nil"/>
                    <w:bottom w:val="nil"/>
                    <w:right w:val="nil"/>
                    <w:insideH w:val="nil"/>
                    <w:insideV w:val="nil"/>
                </w:tblBorders>
            </w:tblPr>
            <w:tblGrid>
                <w:gridCol w:w="3200"/>
                <w:gridCol w:w="6880"/>
            </w:tblGrid>
            ${body}
        </w:tbl>`;
};

const decodeHtmlEntities = (text) => String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

const fontSizeHalfPoints = (tag) => {
    const match = String(tag).match(/font-size\s*:\s*([\d.]+)\s*(pt|px)/i);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const halfPoints = match[2].toLowerCase() === "pt"
        ? value * 2
        : value * 1.5;
    return String(Math.max(8, Math.round(halfPoints)));
};

const alignmentFromTag = (tag) => {
    const source = String(tag || "");
    const styleMatch = source.match(/text-align\s*:\s*(left|center|right|justify)/i);
    if (styleMatch) {
        const align = styleMatch[1].toLowerCase();
        return align === "justify" ? "both" : align;
    }
    const alignMatch = source.match(/\balign\s*=\s*["'](left|center|right|justify)["']/i);
    if (alignMatch) {
        const align = alignMatch[1].toLowerCase();
        return align === "justify" ? "both" : align;
    }
    return null;
};

const marginBottomTwips = (tag) => {
    const source = String(tag || "");
    let bottomValue = source.match(/margin-bottom\s*:\s*([\d.]+)\s*(pt|px)/i);

    if (!bottomValue) {
        const shorthand = source.match(/margin\s*:\s*([^;]+)/i);
        if (shorthand) {
            const parts = shorthand[1].trim().split(/\s+/);
            const bottom = parts.length >= 3
                ? parts[2]
                : parts[0];
            const parsed = String(bottom || "").match(/([\d.]+)\s*(pt|px)/i);
            if (parsed) bottomValue = parsed;
        }
    }

    if (!bottomValue) return null;
    const value = Number(bottomValue[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * (bottomValue[2].toLowerCase() === "pt" ? 20 : 15));
};

const inlineRunsXml = (html, baseSize = "22") => {
    const tokens = String(html || "").match(/<[^>]+>|[^<]+/g) || [];
    let state = { bold: false, italic: false, underline: false, size: baseSize };
    const stack = [];
    const segments = [];

    for (const token of tokens) {
        if (token.startsWith("<")) {
            const tag = token.toLowerCase();
            if (/^<br[\s/>]/.test(tag)) {
                segments.push({ text: "\n", ...state });
                continue;
            }
            const isClosing = tag.startsWith("</");
            const isInline = /^<\/?(b|strong|i|em|u|span|font)[\s/>]/.test(tag);
            if (!isInline) continue;

            if (isClosing) {
                if (stack.length) state = stack.pop();
                continue;
            }
            if (tag.endsWith("/>")) continue;

            stack.push({ ...state });
            if (/^<(b|strong)[\s/>]/.test(tag)) state.bold = true;
            if (/^<(i|em)[\s/>]/.test(tag)) state.italic = true;
            if (/^<u[\s/>]/.test(tag)) state.underline = true;
            const size = fontSizeHalfPoints(token);
            if (size) state.size = size;
            if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(token)) state.bold = true;
            if (/font-style\s*:\s*italic/i.test(token)) state.italic = true;
            if (/text-decoration[^;]*underline/i.test(token)) state.underline = true;
            continue;
        }
        segments.push({ text: decodeHtmlEntities(token), ...state });
    }

    return segments
        .filter(segment => segment.text !== "")
        .map(segment => {
            const texts = segment.text
                .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
                .split("\n")
                .map(part => `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`)
                .join("<w:br/>");
            return `<w:r>
                <w:rPr>
                    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
                    ${segment.bold ? "<w:b/>" : ""}
                    ${segment.italic ? "<w:i/>" : ""}
                    <w:sz w:val="${segment.size}"/>
                    <w:szCs w:val="${segment.size}"/>
                    ${segment.underline ? "<w:u w:val=\"single\"/>" : ""}
                </w:rPr>
                ${texts}
            </w:r>`;
        })
        .join("");
};

const PAGE_BREAK_PARAGRAPH = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

const hasPageBreakBefore = (tag) =>
    /page-break-before\s*:\s*(always|page)/i.test(String(tag || "")) ||
    /break-before\s*:\s*page/i.test(String(tag || ""));

const hasPageBreakAfter = (tag) =>
    /page-break-after\s*:\s*(always|page)/i.test(String(tag || "")) ||
    /break-after\s*:\s*page/i.test(String(tag || ""));

const richParagraph = (html, options = {}) => {
    const align = options.align ? `<w:jc w:val="${options.align}"/>` : "";
    const indent = options.indent ? `<w:ind w:left="${options.indent}"/>` : "";
    const pageBreakBefore = options.pageBreakBefore
        ? "<w:pageBreakBefore/>"
        : "";
    const before = options.before ?? 0;
    const after = options.after ?? 80;
    const runs = inlineRunsXml(html, options.size || "22");

    return `<w:p>
            <w:pPr>
                ${pageBreakBefore}
                <w:spacing w:before="${before}" w:after="${after}" w:line="276" w:lineRule="auto"/>
                ${indent}
                ${align}
            </w:pPr>
            ${runs}
        </w:p>`;
};

const htmlTableXml = (tableHtml) => {
    const hasBorder = /border\s*=\s*["']?[1-9]/i.test(tableHtml) ||
        /border[^:;]*:\s*[1-9]/i.test(tableHtml);
    const borderVal = hasBorder ? "single" : "nil";
    const rows = [];

    for (const rowMatch of String(tableHtml).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [];
        for (const cellMatch of rowMatch[1].matchAll(/<(t[dh])([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
            cells.push({
                html: cellMatch[3],
                header: cellMatch[1].toLowerCase() === "th",
                align: alignmentFromTag(cellMatch[2])
            });
        }
        if (cells.length) rows.push(cells);
    }

    if (!rows.length) return "";

    const columnCount = Math.max(...rows.map(row => row.length));
    const width = Math.floor(10080 / columnCount);
    const body = rows.map(row => `
        <w:tr>
            ${row.map(cell => `
            <w:tc>
                <w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>
                ${richParagraph(cell.html, { align: cell.align, size: "22", after: 40 })}
            </w:tc>`).join("")}
        </w:tr>
    `).join("");

    return `<w:tbl>
            <w:tblPr>
                <w:tblW w:w="10080" w:type="dxa"/>
                <w:tblBorders>
                    <w:top w:val="${borderVal}" w:sz="4"/>
                    <w:left w:val="${borderVal}" w:sz="4"/>
                    <w:bottom w:val="${borderVal}" w:sz="4"/>
                    <w:right w:val="${borderVal}" w:sz="4"/>
                    <w:insideH w:val="${borderVal}" w:sz="4"/>
                    <w:insideV w:val="${borderVal}" w:sz="4"/>
                </w:tblBorders>
            </w:tblPr>
            <w:tblGrid>
                ${Array.from({ length: columnCount }, () => `<w:gridCol w:w="${width}"/>`).join("")}
            </w:tblGrid>
            ${body}
        </w:tbl>`;
};

const htmlBlocksXml = (content) => {
    const html = String(content || "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
    const blockPattern = /<table[^>]*>[\s\S]*?<\/table>|<(ol|ul)[^>]*>[\s\S]*?<\/\1>|<h([1-6])[^>]*>[\s\S]*?<\/h\2>|<(p|div)([^>]*)>([\s\S]*?)<\/\3>|<br\s*\/?>|[^<]+/gi;
    const parts = [];
    let match;

    while ((match = blockPattern.exec(html)) !== null) {
        const token = match[0];
        const lower = token.toLowerCase();

        if (lower.startsWith("<table")) {
            const openingTag = token.match(/^<table[^>]*>/i)?.[0] || "";
            if (hasPageBreakBefore(openingTag)) {
                parts.push(PAGE_BREAK_PARAGRAPH);
            }
            parts.push(htmlTableXml(token));
            if (hasPageBreakAfter(openingTag)) {
                parts.push(PAGE_BREAK_PARAGRAPH);
            }
            continue;
        }

        if (lower.startsWith("<ol") || lower.startsWith("<ul")) {
            const ordered = lower.startsWith("<ol");
            const items = [...token.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
                .map(item => item[1]);
            items.forEach((item, itemIndex) => {
                const prefix = ordered ? `${itemIndex + 1}. ` : "• ";
                parts.push(richParagraph(prefix + item, { indent: "360", after: 40 }));
            });
            continue;
        }

        if (/^<h[1-6]/.test(lower)) {
            const openingTag = token.match(/^<h[1-6][^>]*>/i)?.[0] || "";
            const level = Number(lower.charAt(2));
            const inner = token.replace(/^<h[1-6][^>]*>/i, "").replace(/<\/h[1-6]>$/i, "");
            parts.push(richParagraph(inner, {
                align: alignmentFromTag(token),
                size: level <= 1 ? "32" : level === 2 ? "28" : "24",
                before: 160,
                after: 80,
                pageBreakBefore: hasPageBreakBefore(openingTag)
            }));
            if (hasPageBreakAfter(openingTag)) {
                parts.push(PAGE_BREAK_PARAGRAPH);
            }
            continue;
        }

        if (lower.startsWith("<p") || lower.startsWith("<div")) {
            const openingTag = token.match(/^<(?:p|div)[^>]*>/i)?.[0] || "";
            const inner = token
                .replace(/^<(?:p|div)[^>]*>/i, "")
                .replace(/<\/(?:p|div)>$/i, "");
            const plainText = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ""));
            const breakBefore = hasPageBreakBefore(openingTag);
            const breakAfter = hasPageBreakAfter(openingTag);

            if (!plainText.trim()) {
                if (breakBefore || breakAfter) {
                    parts.push(PAGE_BREAK_PARAGRAPH);
                } else {
                    parts.push(richParagraph("", { after: 0 }));
                }
            } else {
                parts.push(richParagraph(inner, {
                    align: alignmentFromTag(openingTag),
                    size: fontSizeHalfPoints(openingTag) || "22",
                    after: marginBottomTwips(openingTag) ?? 80,
                    pageBreakBefore: breakBefore
                }));
                if (breakAfter) {
                    parts.push(PAGE_BREAK_PARAGRAPH);
                }
            }
            continue;
        }

        if (/^<br/.test(lower)) {
            parts.push(richParagraph("", { after: 0 }));
            continue;
        }

        for (const line of decodeHtmlEntities(token).split("\n")) {
            if (line.trim()) {
                parts.push(richParagraph(escapeXml(line.trim())));
            }
        }
    }

    return parts.join("");
};

const buildFormattedOfferLetterDocx = async (content) => {
    const isHtml = /<(p|div|table|ul|ol|li|h[1-6]|br)\b/i.test(String(content || ""));
    const htmlBody = isHtml ? htmlBlocksXml(content) : null;
    const blocks = isHtml ? [] : parseOfferLetterBlocks(content);
    const body = isHtml ? htmlBody : blocks.map(block => {
        if (block.type === "blank") return offerParagraph("", { after: 0 });
        if (block.type === "title") {
            return offerParagraph(block.text, {
                align: "center",
                bold: true,
                size: "32",
                before: 160,
                after: 160
            });
        }
        if (block.type === "heading") {
            return offerParagraph(block.text, {
                bold: true,
                size: "24",
                before: 160,
                after: 60
            });
        }
        if (block.type === "bullet") {
            return offerParagraph(block.text, { indent: "360", after: 40 });
        }
        if (block.type === "table") return offerTable(block.rows);
        return offerParagraph(block.text);
    }).join("");

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
            <w:body>
                ${body}
                <w:sectPr>
                    <w:pgSz w:w="11906" w:h="16838"/>
                    <w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850"/>
                </w:sectPr>
            </w:body>
        </w:document>`;

    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
            <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
        </Types>`);
    zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>`);
    zip.folder("word").file("document.xml", documentXml);
    zip.folder("word").file("styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
                <w:name w:val="Normal"/>
                <w:rPr>
                    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
                    <w:sz w:val="22"/>
                    <w:szCs w:val="22"/>
                </w:rPr>
            </w:style>
        </w:styles>`);
    zip.folder("word").folder("_rels").file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>`);

    return zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE"
    });
};

const buildOfferLetterDocx = async (lines) => {
    const paragraphs = lines.map(line => `
        <w:p>
            <w:r>
                <w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
                <w:t xml:space="preserve">${escapeXml(line)}</w:t>
            </w:r>
        </w:p>
    `).join("");

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
                ${paragraphs}
                <w:sectPr>
                    <w:pgSz w:w="12240" w:h="15840"/>
                    <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
                </w:sectPr>
            </w:body>
        </w:document>`;

    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        </Types>`);
    zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>`);
    zip.folder("word").file("document.xml", documentXml);
    zip.folder("word").folder("_rels").file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);

    return zip.generateAsync({ type: "nodebuffer" });
};

export const downloadOfferLetter = async (req, res) => {
    try {
        const username = String(req.query.username || "").trim();
        const templateFile = await getOfferLetterTemplateFileModel();

        if (!username) {
            if (!templateFile) {
                return res.status(404).json({
                    success: false,
                    message: "Offer letter template has not been configured"
                });
            }

            res.setHeader(
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            );
            res.setHeader(
                "Content-Disposition",
                "attachment; filename=\"Offer-Letter-Format.docx\""
            );
            return res.send(templateFile);
        }

        const employee = await getOfferLetterEmployeeModel(username);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        let file;
        if (templateFile) {
            file = await fillOfferLetterDocx(templateFile, employee);
        } else {
            const template = await getOfferLetterFormatModel();
            if (!template?.content_html) {
                return res.status(404).json({
                    success: false,
                    message: "Offer letter template has not been configured"
                });
            }
            const letter = fillOfferLetter(restoreHtml(template.content_html), employee);
            file = await buildFormattedOfferLetterDocx(letter);
        }
        const filename = `Offer-Letter-${employee.username || username}.docx`;

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${filename}"`
        );
        return res.send(file);
    } catch (error) {
        console.error("DOWNLOAD OFFER LETTER ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to download offer letter",
            error: error.message
        });
    }
};

export const downloadOfferLetterFromContent = async (req, res) => {
    try {
        const body = typeof req.body === "object" && req.body !== null
            ? req.body
            : {};

        let content = restoreHtml(body.content_html);
        if (typeof content !== "string" || !content.trim()) {
            const template = await getOfferLetterFormatModel();
            content = restoreHtml(template?.content_html);
        }

        if (typeof content !== "string" || !content.trim()) {
            return res.status(400).json({
                success: false,
                message: "Offer letter format is not available"
            });
        }

        const values = {};
        const collectValues = (source) => {
            if (!source || typeof source !== "object") return;
            for (const [key, value] of Object.entries(source)) {
                if (key === "content_html" || key === "fields" || key === "data") continue;
                if (
                    typeof value === "string" ||
                    typeof value === "number" ||
                    typeof value === "boolean"
                ) {
                    values[key] = String(value);
                }
            }
        };
        collectValues(body);
        collectValues(body.fields);
        collectValues(body.data);

        const filledContent = content.replace(
            /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
            (match, key) => (
                Object.prototype.hasOwnProperty.call(values, key)
                    ? values[key]
                    : match
            )
        );

        const file = Buffer.from(
            await buildFormattedOfferLetterDocx(filledContent)
        );
        res.status(200);
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        const personName = [values.first_name, values.last_name]
            .filter(Boolean)
            .join("-")
            .replace(/[^a-zA-Z0-9-_]+/g, "-")
            .replace(/^-+|-+$/g, "");
        const fileName = personName
            ? `Offer-Letter-${personName}.docx`
            : "Offer-Letter.docx";
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`
        );
        res.setHeader("Content-Length", file.length);
        res.setHeader("Content-Encoding", "identity");
        res.setHeader("Cache-Control", "no-store");
        return res.end(file);
    } catch (error) {
        console.error("DOWNLOAD OFFER LETTER CONTENT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to download offer letter",
            error: error.message
        });
    }
};

export const getOfferLetterFormatHistory = async (req, res) => {
    try {
        const limit = Math.min(
            100,
            Math.max(1, Number.parseInt(req.query.limit, 10) || 50)
        );
        const offset = Math.max(
            0,
            Number.parseInt(req.query.offset, 10) || 0
        );
        const history = await getOfferLetterFormatHistoryModel({
            limit,
            offset
        });

        return res.status(200).json({
            success: true,
            data: history.map(entry => ({
                id: entry.id,
                old_value: restoreHtml(entry.old_value),
                new_value: restoreHtml(entry.new_value),
                updated_by: entry.updated_by,
                updated_at: entry.updated_at
            }))
        });
    } catch (error) {
        console.error("GET OFFER LETTER FORMAT HISTORY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch offer letter format history",
            error: error.message
        });
    }
};

/* ================= GET EMPLOYEE FILED NAME ================= */
export const getEmployeeFieldNames = async (
    req,
    res
) => {
    try {
        const search = req.query.search ?? req.query.q ?? null;
        const fieldNames = await getEmployeeFieldNamesModel({
            search
        });

        return res.status(200).json({
            success: true,
            field_names: fieldNames
        });

    } catch (error) {
        console.error("GET EMPLOYEE FIELD NAMES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};