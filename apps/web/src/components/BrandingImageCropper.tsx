import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

export type BrandingImageSelection = {
  file: File;
  sourceWidth: number;
  sourceHeight: number;
  squareCrop?: { x: number; y: number; size: number };
  focalPoint?: { x: number; y: number };
};

type ImageSize = { width: number; height: number };
type CropRect = { x: number; y: number; width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const squareCropFor = (size: ImageSize, positionX: number, positionY: number, zoom: number) => {
  const cropSize = Math.max(1, Math.round(Math.min(size.width, size.height) / zoom));
  const centerX = (positionX / 100) * size.width;
  const centerY = (positionY / 100) * size.height;
  return {
    x: Math.round(clamp(centerX - cropSize / 2, 0, size.width - cropSize)),
    y: Math.round(clamp(centerY - cropSize / 2, 0, size.height - cropSize)),
    size: cropSize
  };
};

const coverCropFor = (size: ImageSize, targetWidth: number, targetHeight: number, positionX: number, positionY: number): CropRect => {
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = size.width / size.height;
  const width = sourceAspect > targetAspect ? Math.round(size.height * targetAspect) : size.width;
  const height = sourceAspect > targetAspect ? size.height : Math.round(size.width / targetAspect);
  const centerX = (positionX / 100) * size.width;
  const centerY = (positionY / 100) * size.height;
  return {
    x: Math.round(clamp(centerX - width / 2, 0, size.width - width)),
    y: Math.round(clamp(centerY - height / 2, 0, size.height - height)),
    width,
    height
  };
};

function CropCanvas({
  image,
  crop,
  width,
  height,
  className,
  onPoint
}: {
  image?: HTMLImageElement;
  crop?: CropRect;
  width: number;
  height: number;
  className: string;
  onPoint?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !image || !crop) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  }, [crop, height, image, width]);

  const selectPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!onPoint) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onPoint(
      clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
    );
  };

  return <canvas ref={ref} width={width} height={height} className={className} onPointerDown={selectPoint} aria-label="Crop preview" />;
}

export function BrandingImageCropper({
  kind,
  onChange,
  disabled = false
}: {
  kind: 'profile' | 'cover';
  onChange: (selection?: BrandingImageSelection) => void;
  disabled?: boolean;
}) {
  const [file, setFile] = useState<File>();
  const [objectUrl, setObjectUrl] = useState('');
  const [image, setImage] = useState<HTMLImageElement>();
  const [size, setSize] = useState<ImageSize>();
  const [positionX, setPositionX] = useState(50);
  const [positionY, setPositionY] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  useEffect(() => {
    if (!file || !objectUrl) {
      setImage(undefined);
      setSize(undefined);
      onChangeRef.current(undefined);
      return;
    }
    const nextImage = new Image();
    nextImage.onload = () => {
      const nextSize = { width: nextImage.naturalWidth, height: nextImage.naturalHeight };
      setImage(nextImage);
      setSize(nextSize);
      setError('');
    };
    nextImage.onerror = () => {
      setError('This image could not be previewed. Try a JPEG, PNG, or WebP file.');
      setImage(undefined);
      setSize(undefined);
      onChangeRef.current(undefined);
    };
    nextImage.src = objectUrl;
  }, [file, objectUrl]);

  const squareCrop = size ? squareCropFor(size, positionX, positionY, zoom) : undefined;
  const desktopCrop = size ? coverCropFor(size, 2400, 900, positionX, positionY) : undefined;
  const mobileCrop = size ? coverCropFor(size, 900, 1200, positionX, positionY) : undefined;

  useEffect(() => {
    if (!file || !size) return;
    onChangeRef.current({
      file,
      sourceWidth: size.width,
      sourceHeight: size.height,
      ...(kind === 'profile'
        ? { squareCrop: squareCropFor(size, positionX, positionY, zoom) }
        : { focalPoint: { x: positionX / 100, y: positionY / 100 } })
    });
  }, [file, kind, positionX, positionY, size, zoom]);

  const chooseFile = (next?: File) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setFile(undefined);
    setObjectUrl('');
    setImage(undefined);
    setSize(undefined);
    setPositionX(50);
    setPositionY(50);
    setZoom(1);
    setError('');
    onChangeRef.current(undefined);
    if (!next) return;
    if (!next.type.startsWith('image/')) {
      setError('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (next.size > 25 * 1024 * 1024) {
      setError('Choose an image smaller than 25 MB.');
      return;
    }
    setFile(next);
    setObjectUrl(URL.createObjectURL(next));
  };

  const setFocalPointFromPreview = (crop: CropRect | undefined, x: number, y: number) => {
    if (!size || !crop) return;
    setPositionX(clamp(((crop.x + crop.width * x) / size.width) * 100, 0, 100));
    setPositionY(clamp(((crop.y + crop.height * y) / size.height) * 100, 0, 100));
  };

  const profileCropRect = squareCrop ? { x: squareCrop.x, y: squareCrop.y, width: squareCrop.size, height: squareCrop.size } : undefined;
  const dimensions = size ? `${size.width.toLocaleString()} × ${size.height.toLocaleString()} px` : '';
  const focalMarkerStyle = (crop?: CropRect): CSSProperties | undefined => {
    if (!crop || !size) return undefined;
    return {
      left: `${clamp((((positionX / 100) * size.width - crop.x) / crop.width) * 100, 0, 100)}%`,
      top: `${clamp((((positionY / 100) * size.height - crop.y) / crop.height) * 100, 0, 100)}%`
    };
  };
  const resolutionWarning = size && (
    (kind === 'profile' && Math.min(size.width, size.height) < 512)
    || (kind === 'cover' && (size.width < 2400 || size.height < 1200))
  );

  return (
    <section className={`branding-cropper branding-cropper-${kind}`}>
      <div className="branding-cropper-heading">
        <div>
          <strong>{kind === 'profile' ? 'Profile image' : 'Cover image'}</strong>
          <p>{kind === 'profile' ? 'Choose the square crop used anywhere your avatar appears.' : 'Choose the focal point and verify both responsive crops.'}</p>
        </div>
        {dimensions && <span>{dimensions}</span>}
      </div>

      <label className="branding-file-picker">
        <span>{file ? 'Choose a different image' : 'Choose image'}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled} onChange={(event) => chooseFile(event.target.files?.[0])} />
      </label>

      <div className="branding-guidelines">
        {kind === 'profile' ? (
          <>
            <strong>Profile image guidelines</strong>
            <span>Use a square image at least 512 × 512 px; 1200 × 1200 px is recommended.</span>
            <span>The outer circle is the final crop. At Zoom 1 it uses the largest square the source image allows.</span>
          </>
        ) : (
          <>
            <strong>Cover image guidelines</strong>
            <span>Use at least 2400 × 1600 px when possible. Keep the subject near the focal marker.</span>
            <span>Desktop exports at 2400 × 900; mobile exports at 900 × 1200. The sides will crop differently.</span>
          </>
        )}
        <span>JPEG, PNG, or WebP · maximum 25 MB. Outputs are resized and optimized as JPEG.</span>
      </div>

      {image && size && kind === 'profile' && (
        <div className="branding-profile-crop-layout">
          <div className="branding-profile-crop-preview">
            <CropCanvas image={image} crop={profileCropRect} width={512} height={512} className="branding-crop-canvas" onPoint={(x, y) => setFocalPointFromPreview(profileCropRect, x, y)} />
            <span className="branding-avatar-crop-boundary" aria-hidden="true" />
          </div>
          <div className="branding-crop-controls">
            <label><span>Horizontal position</span><input type="range" min="0" max="100" value={positionX} onChange={(event) => setPositionX(Number(event.target.value))} /></label>
            <label><span>Vertical position</span><input type="range" min="0" max="100" value={positionY} onChange={(event) => setPositionY(Number(event.target.value))} /></label>
            <label><span>Zoom</span><input type="range" min="1" max="3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
            {squareCrop && <p className="branding-crop-summary">Crop: {squareCrop.size.toLocaleString()} × {squareCrop.size.toLocaleString()} px{zoom === 1 ? ' · maximum size' : ''}</p>}
            <button type="button" className="auth-secondary-btn" onClick={() => { setPositionX(50); setPositionY(50); setZoom(1); }}>Reset crop</button>
          </div>
        </div>
      )}

      {resolutionWarning && <p className="branding-resolution-warning">This image is below the recommended dimensions and may appear soft on larger screens.</p>}

      {image && size && kind === 'cover' && (
        <div className="branding-cover-crop-layout">
          <div className="branding-cover-previews">
            <figure>
              <figcaption>Desktop · 8:3</figcaption>
              <div className="branding-cover-preview branding-cover-preview-desktop">
                <CropCanvas image={image} crop={desktopCrop} width={960} height={360} className="branding-crop-canvas" onPoint={(x, y) => setFocalPointFromPreview(desktopCrop, x, y)} />
                <span className="branding-cover-safe-area" aria-hidden="true" />
                <span className="branding-focal-marker" style={focalMarkerStyle(desktopCrop)} aria-hidden="true" />
              </div>
            </figure>
            <figure>
              <figcaption>Mobile · 3:4</figcaption>
              <div className="branding-cover-preview branding-cover-preview-mobile">
                <CropCanvas image={image} crop={mobileCrop} width={360} height={480} className="branding-crop-canvas" onPoint={(x, y) => setFocalPointFromPreview(mobileCrop, x, y)} />
                <span className="branding-cover-safe-area" aria-hidden="true" />
                <span className="branding-focal-marker" style={focalMarkerStyle(mobileCrop)} aria-hidden="true" />
              </div>
            </figure>
          </div>
          <div className="branding-crop-controls">
            <p>Click either preview or use the sliders to move the shared focal point.</p>
            <label><span>Horizontal focus</span><input type="range" min="0" max="100" value={positionX} onChange={(event) => setPositionX(Number(event.target.value))} /></label>
            <label><span>Vertical focus</span><input type="range" min="0" max="100" value={positionY} onChange={(event) => setPositionY(Number(event.target.value))} /></label>
            <button type="button" className="auth-secondary-btn" onClick={() => { setPositionX(50); setPositionY(50); }}>Centre focal point</button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}
