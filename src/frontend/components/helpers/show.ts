import { get } from "svelte/store"
import type { Item, Show, ShowList, Shows, Slide, TrimmedShow, TrimmedShows } from "../../../types/Show"
import { activeShow, cachedShowsData, customMetadata, dictionary, groupNumbers, groups, shows, showsCache, sorted, sortedShowsList, stageShows } from "../../stores"
import { clone, keysToID, removeValues, sortByName, sortByNameAndNumber } from "./array"
import { GetLayout } from "./get"
import { history } from "./history"
import { _show } from "./shows"

// check if name exists and add number
export function checkName(name: string = "", showId: string = "") {
    if (!name || typeof name !== "string") name = get(dictionary).main?.unnamed || "Unnamed"
    name = formatToFileName(name)

    let number = 1
    while (Object.entries(get(shows)).find(([id, a]) => (!showId || showId !== id) && a.name?.toLowerCase() === (number > 1 ? name.toLowerCase() + " " + number : name.toLowerCase()))) number++

    // add number if existing name, and trim away spaces from the start/end
    return (number > 1 ? name + " " + number : name).trim()
}

export function formatToFileName(name: string = "") {
    // remove illegal file name characters
    name = name.trim().replace(/[/\\?%*:|"<>╠]/g, "")
    // max 255 length
    if (name.length > 255) name = name.slice(0, 255)

    return name
}

// convert any text to a label id format
export function getLabelId(label: string, replaceNumbers: boolean = true) {
    // TODO: disallow chars in labels: #:;!.,- ??
    label = label
        .toLowerCase()
        .replace(/x[0-9]/g, "") // x0-9
        .replace(/[[\]]/g, "") // []
        .replace(/['":]/g, "") // '":
        .trim()
        .replaceAll(" ", "_") // " " -> _
        .replaceAll("-", "_") // - -> _

    if (replaceNumbers) label = label.replace(/[0-9]/g, "")

    return label
    // .replace(/[0-9-]/g, "")
}

// check if label exists as a global label
export function getGlobalGroup(group: string, returnInputIfNull: boolean = false): string {
    let groupId = getLabelId(group)

    if (get(groups)[groupId]) return groupId

    let matchingName = Object.keys(get(groups)).find((groupId) => {
        return get(groups)[groupId].name === group
    })
    if (matchingName) return matchingName

    // find group based on language
    let globalGroup: string = ""
    Object.entries(get(dictionary).groups || {}).forEach(([id, name]) => {
        if (name.toLowerCase() === groupId) globalGroup = id
    })
    return globalGroup || (returnInputIfNull ? groupId : "")
}

// get group number (dynamic counter)
export function getGroupName({ show, showId }: { show: Show; showId: string }, slideID: string, groupName: string | null, layoutIndex: number, addHTML: boolean = false, layoutNumber: boolean = true) {
    let name = groupName
    if (name === null) return name // child slide

    if (!name?.length) name = layoutNumber ? "—" : ""
    if (!get(groupNumbers)) return name

    // sort by order when just one layout
    let slides = keysToID(clone(show.slides || {}))
    if (Object.keys(show.layouts || {}).length < 2) {
        let layoutSlides = Object.values(show.layouts || {})[0]?.slides?.map(({ id }) => id) || []
        slides = slides.sort((a, b) => layoutSlides.indexOf(a.id) - layoutSlides.indexOf(b.id))
    }

    // different slides with same name
    let currentSlide = show.slides?.[slideID] || {}
    let allSlidesWithSameGroup = slides.filter((a) => a.group === currentSlide.group)
    let currentIndex = allSlidesWithSameGroup.findIndex((a) => a.id === slideID)
    let currentGroupNumber = allSlidesWithSameGroup.length > 1 ? " " + (currentIndex + 1) : ""
    name += currentGroupNumber

    // same group - count
    let layoutRef = getLayoutRef(showId)
    let allGroupLayoutSlides = layoutRef.filter((a) => a.id === slideID)
    let currentGroupLayoutIndex = allGroupLayoutSlides.findIndex((a) => a.layoutIndex === layoutIndex)
    let currentLayoutNumberHTML = allGroupLayoutSlides.length > 1 ? '<span class="group_count">' + (currentGroupLayoutIndex + 1) + "</span>" : ""
    let currentLayoutNumber = allGroupLayoutSlides.length > 1 ? " (" + (currentGroupLayoutIndex + 1) + ")" : ""
    if (layoutNumber) name += addHTML ? currentLayoutNumberHTML : currentLayoutNumber

    return name
}

// mirror & events
export function getListOfShows(removeCurrent: boolean = false) {
    let list = Object.entries(get(shows)).map(([id, show]) => ({ id, name: show.name }))
    if (removeCurrent) list = list.filter((a) => a.id !== get(activeShow)?.id)
    list = sortByName(list)
    return list
}

export function getStageList() {
    return Object.entries(clone(get(stageShows))).map(([id, stage]) => ({ id, name: stage.name }))
}

// meta
export function initializeMetadata({ number = "", title = "", artist = "", author = "", composer = "", publisher = "", copyright = "", CCLI = "", year = "", key = "" }) {
    return { number, title, artist, author, composer, publisher, copyright, CCLI, year, key }
}
export function getCustomMetadata() {
    let defaultKeys = Object.keys(initializeMetadata({}))

    const customKeys = get(customMetadata).custom?.filter(Boolean) || []
    const values: { [key: string]: string } = {}

    defaultKeys.forEach((key) => {
        if (get(customMetadata).disabled?.includes(key)) return
        values[key] = ""
    })
    customKeys.forEach((key) => {
        values[key] = ""
    })

    return values
}

export const metadataDisplayValues = [
    { id: "never", name: "$:show_at.never:$" },
    { id: "first", name: "$:show_at.first:$" },
    { id: "last", name: "$:show_at.last:$" },
    { id: "first_last", name: "$:show_at.first_last:$" },
    { id: "always", name: "$:show_at.always:$" },
]

// create new slides
export function newSlide(data: { items?: Item[]; group?: string; globalGroup?: string; notes?: string }): Slide {
    return {
        group: null,
        color: null,
        settings: {},
        notes: "",
        items: [],
        ...data,
    }
}

// update list for drawer
export function updateShowsList(shows: TrimmedShows) {
    // sort shows in alphabeticly order & remove private shows
    let showsList = keysToID(shows)

    let sortType = get(sorted).shows?.type || "name"
    // sort by name regardless if many shows have the same date
    let sortedShows: (TrimmedShow & { id: string })[] = []
    if (sortType === "created") {
        sortedShows = showsList.sort((a, b) => b.timestamps?.created - a.timestamps?.created)
    } else if (sortType === "modified") {
        sortedShows = showsList.sort((a, b) => (b.timestamps?.modified || b.timestamps?.created) - (a.timestamps?.modified || a.timestamps?.created))
    } else if (sortType === "used") {
        sortedShows = showsList.sort((a, b) => (b.timestamps?.used || b.timestamps?.created) - (a.timestamps?.used || a.timestamps?.created))
    } else {
        // sort by name
        sortedShows = sortByNameAndNumber(showsList)
        if (sortType === "name_des") sortedShows = sortedShows.reverse()
    }

    let filteredShows: ShowList[] = removeValues(sortedShows, "private", true)
    sortedShowsList.set(filteredShows)
}

// update cached shows
export function updateCachedShows(shows: Shows) {
    let cachedShows = {}
    Object.entries(shows).forEach(([id, show]) => {
        let customId = getShowCacheId(id, show)
        cachedShows[customId] = updateCachedShow(id, show)
    })
    cachedShowsData.set(cachedShows)
}

export function getShowCacheId(id: string, show: Show | null, layout: string = "") {
    if (!show && !layout) return ""
    return `${id}_${layout || show?.settings?.activeLayout}`
}

// get cached show by layout (used for multiple of the same shows with different layout selected in "Focus mode")
export function getCachedShow(id: string, layout: string = "", updater = get(cachedShowsData)) {
    let show = get(showsCache)[id]
    let customId = getShowCacheId(id, show, layout)
    let cachedShow = updater[customId]
    if (cachedShow || !layout) return cachedShow

    cachedShow = updateCachedShow(id, show, layout)
    cachedShowsData.update((a) => {
        a[customId] = cachedShow
        return a
    })

    return cachedShow
}

// update cached show
export function updateCachedShow(id: string, show: Show, layoutId: string = "") {
    // WIP looped many times when show not loading
    // console.log(id, show)
    if (!show) return

    let layout = GetLayout(id, layoutId)
    // $: activeLayout = $showsCache[$activeShow!.id]?.settings?.activeLayout
    // let layout = _show(id).layouts(activeLayout).ref()[0]

    let endIndex = -1
    if (layout.length) {
        let lastEnabledSlide: number = layout.findIndex((a) => a.end === true && a.disabled !== true)
        if (lastEnabledSlide >= 0) endIndex = lastEnabledSlide
    }

    let customId = getShowCacheId(id, show)
    let template = {
        id: show.settings?.template,
        slidesUpdated: cachedShowsData[customId]?.template?.slidesUpdated || false,
    }

    // sort by order when just one layout
    let showSlides = keysToID(clone(show.slides || {}))
    if (Object.keys(show.layouts || {}).length < 2) {
        let layoutSlides = Object.values(show.layouts || {})[0]?.slides?.map(({ id }) => id) || []
        showSlides = showSlides.sort((a, b) => layoutSlides.indexOf(a.id) - layoutSlides.indexOf(b.id))
    }

    // create groups
    let addedGroups: { [key: string]: number } = {}
    let showGroups = showSlides.map(createGroups)
    function createGroups(slide: Slide & { id: string }) {
        // update if global group
        if (slide.globalGroup && get(groups)[slide.globalGroup]) {
            let oldGroup = clone({ group: slide.group, color: slide.color })

            slide.group = get(groups)[slide.globalGroup].name
            // get translated name
            if (get(groups)[slide.globalGroup].default) slide.group = get(dictionary).groups?.[slide.group] || slide.group
            slide.color = get(groups)[slide.globalGroup].color

            // update local group
            if (JSON.stringify(oldGroup) !== JSON.stringify({ group: slide.group, color: slide.color })) {
                showsCache.update((a) => {
                    a[id].slides[slide.id].group = slide.group
                    a[id].slides[slide.id].color = slide.color
                    return a
                })
            }
        }

        if (slide.group === null || !get(groupNumbers)) return { ...slide, id: slide.id }
        if (!slide.group) slide.group = "—"

        // add numbers to different slides with same name
        if (addedGroups[slide.group]) {
            addedGroups[slide.group]++
            slide.group += " " + addedGroups[slide.group]
        } else {
            addedGroups[slide.group] = 1

            // find all groups with same name
            let allSameGroups = showSlides.filter((a) => a.group !== null && (a.group || "—") === slide.group)
            if (allSameGroups.length > 1) slide.group += " 1"
        }

        return { ...slide, id: slide.id }
    }
    // sort groups by name
    let sortedGroups = sortByName(
        showGroups.filter((a) => a.group !== null && a.group !== undefined),
        "group"
    )

    return { layout, endIndex, template, groups: sortedGroups }
}

export function removeTemplatesFromShow(showId: string, enableHistory: boolean = false) {
    if (!get(showsCache)[showId]) return

    // remove show template
    if (enableHistory) {
        let settings = { ...clone(_show(showId).get("settings") || {}), template: null }
        history({ id: "UPDATE", newData: { data: settings, key: "settings" }, oldData: { id: showId }, location: { page: "none", id: "show_key" } })
    } else {
        _show(showId).set({ key: "settings.template", value: null })
    }

    // remove any slide templates
    showsCache.update((a) => {
        let show = a[showId]
        Object.values(show.slides || {}).forEach((slide) => {
            if (slide.settings.template) delete slide.settings.template
        })
        return a
    })
}

export function getLayoutRef(showId: string = "active", _updater?: Shows | Show) {
    return _show(showId).layouts("active").ref()[0] || []
}
