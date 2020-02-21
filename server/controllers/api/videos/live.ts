import * as express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { createReqFiles } from '@server/helpers/express-utils'
import { CONFIG } from '@server/initializers/config'
import { MIMETYPES } from '@server/initializers/constants'
import { getVideoActivityPubUrl } from '@server/lib/activitypub/url'
import { videoLiveAddValidator, videoLiveGetValidator } from '@server/middlewares/validators/videos/video-live'
import { VideoLiveModel } from '@server/models/video/video-live'
import { MVideoDetails, MVideoFullLight } from '@server/types/models'
import { VideoCreate, VideoPrivacy, VideoState } from '../../../../shared'
import { ThumbnailType } from '../../../../shared/models/videos/thumbnail.type'
import { logger } from '../../../helpers/logger'
import { sequelizeTypescript } from '../../../initializers/database'
import { createVideoMiniatureFromExisting } from '../../../lib/thumbnail'
import { asyncMiddleware, asyncRetryTransactionMiddleware, authenticate } from '../../../middlewares'
import { TagModel } from '../../../models/video/tag'
import { VideoModel } from '../../../models/video/video'

const liveRouter = express.Router()

const reqVideoFileLive = createReqFiles(
  [ 'thumbnailfile', 'previewfile' ],
  MIMETYPES.IMAGE.MIMETYPE_EXT,
  {
    thumbnailfile: CONFIG.STORAGE.TMP_DIR,
    previewfile: CONFIG.STORAGE.TMP_DIR
  }
)

liveRouter.post('/live',
  authenticate,
  reqVideoFileLive,
  asyncMiddleware(videoLiveAddValidator),
  asyncRetryTransactionMiddleware(addLiveVideo)
)

liveRouter.get('/live/:videoId',
  authenticate,
  asyncMiddleware(videoLiveGetValidator),
  asyncRetryTransactionMiddleware(getVideoLive)
)

// ---------------------------------------------------------------------------

export {
  liveRouter
}

// ---------------------------------------------------------------------------

async function getVideoLive (req: express.Request, res: express.Response) {
  const videoLive = res.locals.videoLive

  return res.json(videoLive.toFormattedJSON())
}

async function addLiveVideo (req: express.Request, res: express.Response) {
  const videoInfo: VideoCreate = req.body

  // Prepare data so we don't block the transaction
  const videoData = {
    name: videoInfo.name,
    remote: false,
    category: videoInfo.category,
    licence: videoInfo.licence,
    language: videoInfo.language,
    commentsEnabled: videoInfo.commentsEnabled !== false, // If the value is not "false", the default is "true"
    downloadEnabled: videoInfo.downloadEnabled !== false,
    waitTranscoding: videoInfo.waitTranscoding || false,
    state: VideoState.WAITING_FOR_LIVE,
    nsfw: videoInfo.nsfw || false,
    description: videoInfo.description,
    support: videoInfo.support,
    isLive: true,
    privacy: videoInfo.privacy || VideoPrivacy.PRIVATE,
    duration: 0,
    channelId: res.locals.videoChannel.id,
    originallyPublishedAt: videoInfo.originallyPublishedAt
  }

  const videoLive = new VideoLiveModel()
  videoLive.streamKey = uuidv4()

  const video = new VideoModel(videoData) as MVideoDetails
  video.url = getVideoActivityPubUrl(video) // We use the UUID, so set the URL after building the object

  // Process thumbnail or create it from the video
  const thumbnailField = req.files ? req.files['thumbnailfile'] : null
  const thumbnailModel = thumbnailField
    ? await createVideoMiniatureFromExisting(thumbnailField[0].path, video, ThumbnailType.MINIATURE, false)
    : null

  // Process preview or create it from the video
  const previewField = req.files ? req.files['previewfile'] : null
  const previewModel = previewField
    ? await createVideoMiniatureFromExisting(previewField[0].path, video, ThumbnailType.PREVIEW, false)
    : null

  const { videoCreated } = await sequelizeTypescript.transaction(async t => {
    const sequelizeOptions = { transaction: t }

    const videoCreated = await video.save(sequelizeOptions) as MVideoFullLight

    if (thumbnailModel) await videoCreated.addAndSaveThumbnail(thumbnailModel, t)
    if (previewModel) await videoCreated.addAndSaveThumbnail(previewModel, t)

    // Do not forget to add video channel information to the created video
    videoCreated.VideoChannel = res.locals.videoChannel

    videoLive.videoId = videoCreated.id
    await videoLive.save(sequelizeOptions)

    // Create tags
    if (videoInfo.tags !== undefined) {
      const tagInstances = await TagModel.findOrCreateTags(videoInfo.tags, t)

      await video.$set('Tags', tagInstances, sequelizeOptions)
      video.Tags = tagInstances
    }

    logger.info('Video live %s with uuid %s created.', videoInfo.name, videoCreated.uuid)

    return { videoCreated }
  })

  return res.json({
    video: {
      id: videoCreated.id,
      uuid: videoCreated.uuid
    }
  }).end()
}